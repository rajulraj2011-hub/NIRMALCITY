"""Automatic partner-coupon feed.

Every COUPON_REFRESH_DAYS (default 4) — on a schedule started by app.py, or
on demand via POST /api/admin/coupons/refresh — this module re-scans the
trusted Indian coupon sources listed in SOURCES, verifies each code against
the live page, and merges results into the `partner_coupons` collection:

  * new paste-codes are added (deduped by website+code, per-brand caps),
  * codes seen again are re-verified (verified_on bumped, validity extended),
  * codes missing from two consecutive successful scans are staled out,
  * entries whose valid_til has passed are expired out of /api/rewards.

Only paste-style promo codes are collected; link/deal offers are ignored.
The hand-verified seed catalog in app.py (COUPON_CATALOG) is never touched
and always wins a dedupe clash — seed codes are passed in as `seed_codes`.

Five of the ten sites the project tracks (CashKaro, Zingoy, DesiDime,
DealZap, Magicpin) never serve paste codes in their public HTML — see
UNAVAILABLE — so they are reported honestly instead of scraped blindly.
"""

from datetime import date, datetime, timedelta, timezone
import html as html_lib
import os
import re
import ssl
import threading
import time
import urllib.error
import urllib.request

# --- Configuration ------------------------------------------------------
def _env_float(name, default):
    try:
        return float(os.getenv(name, ''))
    except (TypeError, ValueError):
        return default


REFRESH_DAYS = _env_float('COUPON_REFRESH_DAYS', 4.0)
# How often the scheduler re-checks whether a refresh is due.
CHECK_MINUTES = _env_float('COUPON_FEED_CHECK_MINUTES', 360.0)
FETCH_TIMEOUT = _env_float('COUPON_FETCH_TIMEOUT', 15.0)
FETCH_DELAY = _env_float('COUPON_FETCH_DELAY', 0.2)     # politeness gap, seconds
AUTO_COST = int(_env_float('COUPON_AUTO_COST', 10))     # points to unlock an auto coupon
HORIZON_DAYS = int(_env_float('COUPON_AUTO_HORIZON_DAYS', 30))  # validity when source gives none
PER_WEBSITE_CAP = 6           # max active auto codes per website
GLOBAL_CAP = 30               # max active auto codes overall
MISS_LIMIT = 2                # unseen on N successful scans -> stale
MAX_FRAGMENTS = 12            # per-store reveal fetches (Cashaly)

USER_AGENT = (
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
    '(KHTML, like Gecko) Chrome/126.0 Safari/537.36'
)

BRAND_URLS = {
    'Myntra': 'https://www.myntra.com/',
    'Swiggy': 'https://www.swiggy.com/',
    'Ajio': 'https://www.ajio.com/',
    'Zomato': 'https://www.zomato.com/',
    'BookMyShow': 'https://in.bookmyshow.com/',
    'Paytm': 'https://paytm.com/',
}

# Sites from the project's source list that publish no paste codes in their
# public HTML. Reported in the feed status so the coverage stays honest.
UNAVAILABLE = [
    {'site': 'CashKaro', 'reason': 'codes load after login; public pages list cashback offers only'},
    {'site': 'Zingoy', 'reason': 'code reveal requires sign-in; public pages show deals only'},
    {'site': 'DesiDime', 'reason': 'store pages serve link-based deals; codes unlock via redirect'},
    {'site': 'DealZap', 'reason': 'codes are stripped from the served HTML (client-side reveal)'},
    {'site': 'Magicpin', 'reason': 'cashback/outlet discounts — the site publishes no coupon codes'},
]

# Codes that pass the shape check but are never real promo codes.
CODE_BLACKLIST = {
    'CODE', 'CODES', 'CASHBACK', 'COUPON', 'COUPONS', 'PROMO', 'PROMOS',
    'PROMOCODE', 'COUPONCODE', 'OFFER', 'OFFERS', 'DEAL', 'DEALS',
    'DISCOUNT', 'EXPIRED', 'EXPIRY', 'VALID', 'VALIDITY', 'COPY', 'APPLY',
    'FLAT', 'UPTO', 'TILL', 'NONE', 'NOCODE', 'NOCODEREQUIRED', 'GETCODE',
    'SHOWCODE', 'MORE', 'LESS', 'ALL', 'TOP', 'TODAY', 'LIVE', 'OFF',
    'SALE', 'NEW', 'FREE', 'SAVE', 'VISIT', 'RETAILER', 'MYNTRA', 'SWIGGY',
    'AJIO', 'ZOMATO', 'PAYTM', 'BOOKMYSHOW', 'BMS', 'FIRST', 'NEWUSER',
}


# --- HTTP ---------------------------------------------------------------
def fetch_page(url, xhr=False, referer=None):
    """GET a page with browser-like headers. Returns (status, text)."""
    headers = {
        'User-Agent': USER_AGENT,
        'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'identity',
    }
    if referer:
        headers['Referer'] = referer
    if xhr:
        headers['X-Requested-With'] = 'XMLHttpRequest'
    request = urllib.request.Request(url, headers=headers)
    try:
        with urllib.request.urlopen(
                request, timeout=FETCH_TIMEOUT,
                context=ssl.create_default_context()) as response:
            body = response.read().decode('utf-8', 'ignore')
            status = getattr(response, 'status', 200)
            final_url = response.geturl()
    except urllib.error.HTTPError as exc:
        try:
            body = exc.read().decode('utf-8', 'ignore')
        except Exception:  # noqa: BLE001
            body = ''
        status = exc.code
        final_url = url
    except Exception as exc:  # noqa: BLE001
        status, body, final_url = 0, str(exc), url
    if FETCH_DELAY > 0:
        time.sleep(FETCH_DELAY)
    return status, body


# --- Parsing helpers ----------------------------------------------------
def strip_markup(text):
    """Tags -> plain text, entities unescaped, whitespace collapsed."""
    text = re.sub(r'<[^>]+>', ' ', text or '')
    text = html_lib.unescape(text)
    return re.sub(r'\s+', ' ', text).strip()


def clean_code(raw):
    """Return a plausible paste-code (A-Z0-9, 3-20 chars) or None."""
    code = html_lib.unescape(raw or '').strip().upper()
    if not re.fullmatch(r'[A-Z0-9][A-Z0-9-]{2,19}', code):
        return None
    if not re.search(r'[A-Z]', code):
        return None
    if code in CODE_BLACKLIST:
        return None
    return code


_DATE_FORMATS = (
    '%b %d %Y', '%b %d, %Y', '%B %d %Y', '%B %d, %Y',
    '%Y-%m-%d', '%d/%m/%Y', '%d-%m-%Y', '%d-%b-%Y',
    '%d %b %Y', '%d %b, %Y', '%d %B %Y', '%d %B, %Y',
)

VALIDITY_RE = re.compile(
    r'(?:valid\s*till|expires?\s*(?:on)?|expiry|validity|till)\s*[:\-]?\s*'
    r'([A-Za-z]{3,9}\s+\d{1,2},?\s+\d{4}'
    r'|\d{4}-\d{2}-\d{2}'
    r'|\d{1,2}[/-]\d{1,2}[/-]\d{2,4}'
    r'|\d{1,2}\s+[A-Za-z]{3,9}\s+\d{4})',
    re.IGNORECASE)


def parse_date(raw):
    """'Oct 31, 2026' / '31-10-2026' / '2026-10-31' -> ISO date or None."""
    if not raw:
        return None
    text = raw.replace(',', ' ')
    text = re.sub(r'\s+', ' ', text).strip()
    for fmt in _DATE_FORMATS:
        try:
            return datetime.strptime(text, fmt).date().isoformat()
        except ValueError:
            continue
    # Day-first variants (Indian sites): 31/10/2026.
    if re.fullmatch(r'\d{1,2}[/-]\d{1,2}[/-]\d{2,4}', text):
        for fmt in ('%d/%m/%Y', '%d/%m/%y', '%d-%m-%Y', '%d-%m-%y'):
            try:
                return datetime.strptime(
                    text.replace('-', '/'), fmt).date().isoformat()
            except ValueError:
                continue
    return None


def parse_validity(text):
    """Find 'Valid Till: Oct 31, 2026'-style text; return ISO date or None."""
    if not text:
        return None
    match = VALIDITY_RE.search(text)
    if not match:
        return None
    return parse_date(match.group(1))


# --- Source extractors --------------------------------------------------
# Each extractor takes (page_html, page_url) and returns a list of dicts:
# {'code', 'title', 'terms', 'valid_til' (ISO str | None)} — codes already
# validated through clean_code, titles already plain text.

def extract_grabon(page, page_url):
    """GrabOn: card blocks split on id="cpn_NNN"; data-code + title +
    'Valid Till: Oct 31, 2026 (SAT)' inside each block."""
    out = []
    for block in re.split(r'(?=<div[^>]+id="cpn_\d+")', page)[1:]:
        code_m = re.search(r'data-code="([^"]+)"', block)
        if not code_m:
            continue  # deal card (no paste code)
        code = clean_code(code_m.group(1))
        if not code:
            continue
        title_m = re.search(r'<p class="title"[^>]*>(.*?)</p>', block, re.S)
        title = strip_markup(title_m.group(1)) if title_m else ''
        if not title:
            continue
        valid_m = re.search(
            r'Valid Till:\s*([A-Za-z]{3,9}\s+\d{1,2},?\s+\d{4})', block, re.I)
        out.append({'code': code, 'title': title, 'terms': '',
                    'valid_til': parse_date(valid_m.group(1)) if valid_m else None})
    return out


_COUPONDUNIA_KEY_RE = re.compile(
    r'data-offer-key="(offerTitle|couponCode)"\s+data-offer-value="([^"]*)"')


def extract_coupondunia(page, page_url):
    """CouponDunia: offerTitle precedes its couponCode div; deals carry an
    empty couponCode value (skipped)."""
    out = []
    last_title = ''
    for match in _COUPONDUNIA_KEY_RE.finditer(page):
        key, value = match.group(1), html_lib.unescape(match.group(2)).strip()
        if key == 'offerTitle':
            last_title = value
            continue
        code = clean_code(value)
        if code and last_title:
            out.append({'code': code, 'title': last_title, 'terms': '',
                        'valid_til': None})
    return out


_GOPAISA_TITLE_RE = re.compile(r'Style__CouponTilte[^>]*>(.*?)</div>', re.S)
_GOPAISA_CODE_RE = re.compile(r'Style__CouponCode[^>]*>(.*?)</div>', re.S)


def extract_gopaisa(page, page_url):
    """GoPaisa: styled-components SSR — title div, then code div."""
    titles = [(m.start(), strip_markup(m.group(1)))
              for m in _GOPAISA_TITLE_RE.finditer(page)]
    out = []
    for code_m in _GOPAISA_CODE_RE.finditer(page):
        code = clean_code(strip_markup(code_m.group(1)))
        if not code:
            continue
        title = next((t for pos, t in reversed(titles) if pos < code_m.start()), '')
        if not title:
            continue
        out.append({'code': code, 'title': title, 'terms': '',
                    'valid_til': None})
    return out


def extract_cashaly(page, page_url):
    """Cashaly: cards with class token 'Coupon' hold a load-product id; the
    reveal page (XHR) carries <span id="copyLink">CODE</span> plus terms."""
    out = []
    cards = list(re.finditer(r'<div\s+class="([^"]*offer-item-box[^"]*)"', page))
    fragments = 0
    for index, card in enumerate(cards):
        if 'Coupon' not in card.group(1).split():
            continue  # 'Offers' cards are link deals without codes
        block_end = cards[index + 1].start() if index + 1 < len(cards) else len(page)
        block = page[card.start():block_end]
        id_m = re.search(r'load-product/([A-Za-z0-9]+)', block)
        if not id_m:
            continue
        title_m = re.search(
            r'class="font-2 sub-title gray offer-title">([^<]+)', block)
        if not title_m:
            title_m = re.search(r'class="font-1 title black">([^<]+)', block)
        title = strip_markup(title_m.group(1)) if title_m else ''
        if fragments >= MAX_FRAGMENTS:
            continue
        fragments += 1
        status, fragment = fetch_page(
            f'https://www.cashaly.com/load-product/{id_m.group(1)}',
            xhr=True, referer=page_url)
        if status != 200:
            continue
        code_m = re.search(r'<span id="copyLink">([^<]+)</span>', fragment)
        code = clean_code(code_m.group(1)) if code_m else None
        if not code:
            continue
        if not title:
            frag_title = re.search(
                r'class="black font-1 title center-item margin-top">([^<]+)',
                fragment)
            title = strip_markup(frag_title.group(1)) if frag_title else ''
        if not title:
            continue
        terms_m = re.search(
            r'term-tips-word">\s*<img[^>]*>\s*([^<]+?)\s*</div>', fragment, re.S)
        out.append({'code': code, 'title': title,
                    'terms': strip_markup(terms_m.group(1)) if terms_m else '',
                    'valid_til': None})
    return out


def extract_paisawapas(page, page_url):
    """PaisaWapas: the SEO comparison table's 'Coupon Code' column. Rows say
    'No Code Required' while only link deals run — those are filtered by
    clean_code; real codes land here during sales."""
    out = []
    for table in re.findall(
            r'<table[^>]*table-bordered[^>]*>.*?</table>', page, re.S):
        for row in re.findall(r'<tr>(.*?)</tr>', table, re.S):
            cells = [strip_markup(cell)
                     for cell in re.findall(r'<td[^>]*>(.*?)</td>', row, re.S)]
            if len(cells) < 4:
                continue
            code = clean_code(cells[3])
            if code and cells[0]:
                out.append({'code': code, 'title': cells[0], 'terms': '',
                            'valid_til': None})
    return out


# --- Source registry ----------------------------------------------------
SOURCES = [
    {'name': 'grabon', 'label': 'GrabOn', 'extract': extract_grabon,
     'pages': {
         'Myntra': 'https://www.grabon.in/myntra-coupons/',
         'Swiggy': 'https://www.grabon.in/swiggy-coupons/',
         'Ajio': 'https://www.grabon.in/ajio-coupons/',
         'Zomato': 'https://www.grabon.in/zomato-coupons/',
         'BookMyShow': 'https://www.grabon.in/bookmyshow-coupons/',
         'Paytm': 'https://www.grabon.in/paytm-coupons/',
     }},
    {'name': 'coupondunia', 'label': 'CouponDunia', 'extract': extract_coupondunia,
     'pages': {
         'Myntra': 'https://www.coupondunia.in/myntra',
         'Swiggy': 'https://www.coupondunia.in/swiggy',
         'Ajio': 'https://www.coupondunia.in/ajio',
         'Zomato': 'https://www.coupondunia.in/zomato',
         'BookMyShow': 'https://www.coupondunia.in/bookmyshow',
         'Paytm': 'https://www.coupondunia.in/paytm',
     }},
    {'name': 'gopaisa', 'label': 'GoPaisa', 'extract': extract_gopaisa,
     'pages': {
         'Myntra': 'https://www.gopaisa.com/myntra',
         'Swiggy': 'https://www.gopaisa.com/swiggy',
         'BookMyShow': 'https://www.gopaisa.com/bookmyshow',
         'Paytm': 'https://www.gopaisa.com/paytm',
     }},
    {'name': 'cashaly', 'label': 'Cashaly', 'extract': extract_cashaly,
     'pages': {
         'Myntra': 'https://www.cashaly.com/store/myntra-coupons',
         'Swiggy': 'https://www.cashaly.com/store/swiggy-coupons',
         'Ajio': 'https://www.cashaly.com/store/ajio-coupons',
         'Zomato': 'https://www.cashaly.com/store/zomato-coupons',
         'BookMyShow': 'https://www.cashaly.com/store/bookmyshow-coupons',
     }},
    {'name': 'paisawapas', 'label': 'PaisaWapas', 'extract': extract_paisawapas,
     'pages': {
         'Myntra': 'https://www.paisawapas.com/myntra-sale-coupons',
         'Swiggy': 'https://www.paisawapas.com/swiggy-coupons',
     }},
]

# --- Refresh ------------------------------------------------------------
_running_lock = threading.Lock()


def _now():
    return datetime.now(timezone.utc)


def _today():
    """Local (server) date: partner sites and the UI think in IST, so a run at
    05:30 IST must say 'verified today', not yesterday's UTC date."""
    return datetime.now().date().isoformat()


def _meta(db):
    return db['app_meta']


def _iso(moment):
    return moment.isoformat().replace('+00:00', 'Z')


def _parse_iso(value):
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace('Z', '+00:00'))
    except ValueError:
        return None


def refresh(db, manual=False, seed_codes=(), logger=None):
    """Run a feed refresh (or skip when not due). Never raises: failures are
    logged and returned as {'status': 'failed', ...}.

    seed_codes: iterable of (website, code) from the hand-verified seed
    catalog — those codes are never duplicated into partner_coupons.
    """
    def log(message):
        if logger is not None:
            logger(message)

    now = _now()
    if not _running_lock.acquire(blocking=False):
        return {'status': 'skipped', 'reason': 'A refresh is already running.'}
    try:
        meta = _meta(db).find_one({'_id': 'coupon_feed'}) or {}
        last_run = _parse_iso(meta.get('last_run'))
        due = (now - last_run).total_seconds() >= REFRESH_DAYS * 86400 \
            if last_run else True
        if not manual and not due:
            return {'status': 'skipped', 'reason': 'not due',
                    'last_run': meta.get('last_run')}
        try:
            _meta(db).update_one(
                {'_id': 'coupon_feed'},
                {'$set': {'running': True, 'started_at': _iso(now)}},
                upsert=True)
        except Exception:  # noqa: BLE001
            log('coupon feed: could not mark running (DB hiccup)')
        try:
            report = _scan(db, now, seed_codes, log)
        except Exception as exc:  # noqa: BLE001
            log(f'coupon feed: refresh failed: {exc!r}')
            report = {'status': 'failed', 'error': str(exc)}
        report.setdefault('status', 'ran')
        report['ran_at'] = _iso(now)
        report['manual'] = bool(manual)
        try:
            # A failed run must not consume the schedule: keep the old
            # last_run so the next scheduler check retries soon.
            update = {'running': False, 'last_result': report}
            if report['status'] != 'failed':
                update['last_run'] = _iso(now)
            _meta(db).update_one(
                {'_id': 'coupon_feed'},
                {'$set': update},
                upsert=True)
        except Exception:  # noqa: BLE001
            log('coupon feed: could not persist run report (DB hiccup)')
        return report
    finally:
        _running_lock.release()


def _scan(db, now, seed_codes, log):
    """Fetch every configured page, merge findings into partner_coupons."""
    partner = db['partner_coupons']
    today = _today()
    horizon = (date.fromisoformat(today) + timedelta(days=HORIZON_DAYS)).isoformat()
    seed_set = {(str(w).upper(), str(c).upper()) for w, c in seed_codes}

    # page + parse
    pages_report = []
    seen_websites = set()          # website with >=1 page fetched OK
    raw_count = {}                 # website -> codes extracted this run
    found = {}                     # (website, code) -> merged finding

    def note(website, item, source_name, page_url):
        key = (website.upper(), item['code'])
        if key in seed_set:
            return
        existing = found.get(key)
        if existing is None:
            found[key] = {
                'website': website, 'code': item['code'],
                'title': item.get('title') or '',
                'terms': item.get('terms') or '',
                'valid_til': item.get('valid_til'),
                'sites': [source_name], 'pages': [page_url],
            }
            return
        if source_name not in existing['sites']:
            existing['sites'].append(source_name)
        if page_url not in existing['pages']:
            existing['pages'].append(page_url)
        candidate = item.get('valid_til')
        if candidate and (not existing['valid_til']
                          or candidate > existing['valid_til']):
            existing['valid_til'] = candidate
        if item.get('terms') and not existing['terms']:
            existing['terms'] = item['terms']

    for source in SOURCES:
        for website, url in source['pages'].items():
            row = {'source': source['name'], 'website': website}
            try:
                status, page = fetch_page(url)
            except Exception as exc:  # noqa: BLE001
                row.update(http=0, error=str(exc)[:120])
                pages_report.append(row)
                continue
            row['http'] = status
            if status != 200 or not page:
                row['error'] = f'HTTP {status}' if status else 'fetch failed'
                pages_report.append(row)
                continue
            seen_websites.add(website)
            try:
                items = source['extract'](page, url)
            except Exception as exc:  # noqa: BLE001
                row['error'] = f'parse error: {exc}'[:120]
                pages_report.append(row)
                continue
            row['codes'] = len(items)
            raw_count[website] = raw_count.get(website, 0) + len(items)
            for item in items:
                if item.get('code'):
                    note(website, item, source['name'], url)
            pages_report.append(row)

    # merge findings into the collection
    added, refreshed, capped, skipped_expired = [], [], [], []
    for item in found.values():
        website, code = item['website'], item['code']
        valid_til = item['valid_til'] or horizon
        if valid_til < today:
            skipped_expired.append(f'{website}:{code}')
            continue
        doc_id = f'{website.lower()}:{code}'
        if partner.find_one({'_id': doc_id}, {'_id': 1}) is None:
            active_here = partner.count_documents(
                {'website': website, 'status': 'active'})
            active_total = partner.count_documents({'status': 'active'})
            if active_here >= PER_WEBSITE_CAP or active_total >= GLOBAL_CAP:
                capped.append(doc_id)
                continue
        # Dedupe + refresh in one upsert: seen codes get their verified_on
        # bumped (fresh genuine check), validity keeps the farthest date.
        existing = partner.find_one({'_id': doc_id}) or {}
        merged_valid = valid_til
        if existing.get('valid_til') and existing['valid_til'] > merged_valid:
            merged_valid = existing['valid_til']
        seen_sites = sorted(set(existing.get('sources_seen', []))
                            | set(item['sites']))
        doc = {
            'website': website, 'code': code,
            'type': 'cashback' if 'cashback' in item['title'].lower()
                    else 'discount',
            'title': item['title'] or existing.get('title') or f'{website} promo code',
            'terms': item['terms'] or existing.get('terms')
                     or f'Auto-verified via {seen_sites[0]} · partner T&C apply',
            'url': BRAND_URLS.get(website, ''),
            'cost': int(existing.get('cost') or AUTO_COST),
            'valid_til': merged_valid,
            'verified_on': today,
            'source': (item['pages'][0] if item['pages']
                       else existing.get('source', '')),
            'via': seen_sites[0],
            'sources_seen': seen_sites,
            'status': 'active',
            'missed_cycles': 0,
            'seed': False,
            'updated_at': _iso(now),
        }
        result = partner.update_one(
            {'_id': doc_id},
            {'$set': doc, '$setOnInsert': {'added_at': _iso(now)}},
            upsert=True)
        if result.upserted_id:
            added.append({'website': website, 'code': code,
                          'via': item['sites'][0], 'valid_til': merged_valid})
        else:
            refreshed.append(doc_id)

    # By-date expiry first: an entry whose valid_til passed is 'expired',
    # which is different from vanishing from the sources ('stale').
    expired = partner.update_many(
        {'status': 'active', 'valid_til': {'$lt': today}},
        {'$set': {'status': 'expired', 'updated_at': _iso(now)}})

    # miss counting: only when the website's pages really produced codes
    staled = []
    suspicious = {w for w in seen_websites if raw_count.get(w, 0) == 0}
    for doc in partner.find({'status': 'active'}):
        if doc['website'] in suspicious:
            continue  # page change / source hiccup — don't punish entries
        if (doc['website'].upper(), doc['code']) in found:
            continue  # seen this run (missed_cycles already reset above)
        if doc['website'] not in seen_websites:
            continue  # every page for this website failed — no penalty
        cycles = int(doc.get('missed_cycles') or 0) + 1
        if cycles >= MISS_LIMIT:
            partner.update_one({'_id': doc['_id']},
                               {'$set': {'status': 'stale',
                                         'missed_cycles': cycles,
                                         'updated_at': _iso(now)}})
            staled.append(doc['_id'])
        else:
            partner.update_one({'_id': doc['_id']},
                               {'$set': {'missed_cycles': cycles}})

    report = {
        'pages': pages_report,
        'pages_ok': sum(1 for row in pages_report if row.get('http') == 200
                        and not row.get('error')),
        'pages_failed': sum(1 for row in pages_report
                            if row.get('error')),
        'codes_seen': len(found),
        'added': added,
        'refreshed': len(refreshed),
        'capped': capped,
        'expired_skipped': skipped_expired,
        'staled': len(staled),
        'expired': expired.modified_count,
        'suspicious': sorted(suspicious),
        'unavailable': UNAVAILABLE,
    }
    log('coupon feed: '
        f"{report['pages_ok']} pages ok, {len(added)} new, "
        f"{len(refreshed)} re-verified, {len(staled)} staled, "
        f"{expired.modified_count} expired")
    return report


def start_async(db, seed_codes=(), logger=None):
    """Kick off a manual refresh in the background; {'started': bool}."""
    if _running_lock.locked():
        return {'started': False,
                'reason': 'A refresh is already running.'}
    def runner():
        try:
            refresh(db, manual=True, seed_codes=seed_codes, logger=logger)
        except Exception as exc:  # noqa: BLE001
            if logger is not None:
                logger(f'coupon feed: background refresh crashed: {exc!r}')
    threading.Thread(target=runner, daemon=True, name='coupon-feed').start()
    return {'started': True}


def scheduler_loop(db, seed_codes=(), logger=None):
    """Daemon-thread body started by app.py under __main__: check shortly
    after boot (an overdue schedule catches up), then every CHECK_MINUTES;
    refresh() itself decides whether the run is actually due."""
    def log(message):
        if logger is not None:
            logger(message)
    time.sleep(min(30.0, CHECK_MINUTES * 60))
    while True:
        try:
            refresh(db, seed_codes=seed_codes, logger=log)
        except Exception as exc:  # noqa: BLE001
            log(f'coupon feed: scheduled refresh crashed: {exc!r}')
        time.sleep(max(60.0, CHECK_MINUTES * 60))


def status(db, now=None):
    """Everything the admin panel needs to show the feed at a glance."""
    now = now or _now()
    meta = _meta(db).find_one({'_id': 'coupon_feed'}) or {}
    last_run = _parse_iso(meta.get('last_run'))
    next_due = last_run + timedelta(days=REFRESH_DAYS) if last_run else None
    today = _today()
    partner = db['partner_coupons']
    return {
        'refresh_days': REFRESH_DAYS,
        'last_run': meta.get('last_run'),
        'next_due': _iso(next_due) if next_due else None,
        'overdue': bool(next_due and now >= next_due),
        'running': bool(meta.get('running')),
        'last_result': meta.get('last_result'),
        'active_auto': partner.count_documents(
            {'status': 'active', 'valid_til': {'$gte': today}}),
        'sources': [{'name': s['name'], 'label': s['label'],
                     'pages': len(s['pages'])} for s in SOURCES],
        'unavailable': UNAVAILABLE,
    }
