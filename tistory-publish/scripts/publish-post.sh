#!/usr/bin/env bash
# publish-post.sh — 범용 티스토리 발행 오케스트레이터 (OpenClaw Playwright CDP 기반)
#
# 사용법:
#   bash publish-post.sh --title "글 제목" --body-file body.html --category "카테고리"
#   bash publish-post.sh --template mk-review --article-title "기사 제목" --body-file body.html --banner banner.jpg
#
# 필수: --title, --body-file, --category
# 선택: --tags, --banner, --blog, --helper, --private, --template, --article-title, --cdp-port, --require-public-image-figures

set -euo pipefail

# ── 기본값 ──
TITLE=""
ARTICLE_TITLE=""
BODY_FILE=""
CATEGORY=""
TAGS=""
BANNER=""
BANNER_ALT=""
BLOG=""
HELPER=""
TEMPLATE=""
PRIVATE=false
SEO_CHECK="${TISTORY_SEO_CHECK:-off}"
SEO_KEYWORD=""
SEO_MIN_BODY_CHARS="${TISTORY_SEO_MIN_BODY_CHARS:-1000}"
CDP_PORT="${TISTORY_CDP_PORT:-18800}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ALLOW_DIRECT_TISTORY_PUBLISH="${ALLOW_DIRECT_TISTORY_PUBLISH:-}"
RUN_TOKEN="${RUN_TOKEN:-}"
REQUIRE_PUBLIC_IMAGE_FIGURES="${REQUIRE_PUBLIC_IMAGE_FIGURES:-0}"

log() { echo "[$(date +%H:%M:%S)] $*" >&2; }
fail() { echo "{\"success\":false,\"error\":\"$*\"}" ; exit 1; }

usage() {
  cat >&2 <<'EOF'
Usage:
  bash publish-post.sh --title "글 제목" --body-file body.html --category "카테고리"
  bash publish-post.sh --template mk-review --article-title "기사 제목" --body-file body.html --banner banner.jpg

Options:
  --template       템플릿 preset (mk-review, daum-trends, simple-post)
  --title          최종 제목
  --article-title  mk-review용 기사 제목 (자동 접두사 생성)
  --body-file      본문 HTML 파일
  --category       카테고리명
  --tags           쉼표 구분 태그
  --banner         배너 이미지 파일
  --banner-alt     배너 이미지 alt 텍스트 (SEO, 기본: 제목)
  --blog           블로그 도메인 (예: anthropic.tistory.com)
  --helper         JS helper 경로
  --cdp-port       OpenClaw Chrome CDP 포트 (기본: TISTORY_CDP_PORT 또는 18800)
  --private        비공개 발행
  --seo-check      발행 전 SEO 검사: off|warn|strict (기본: off, strict는 error 시 발행 중단)
  --seo-keyword    SEO 핵심 키워드 (기본: 제목 첫 단어)
  --seo-min-body-chars
                  SEO 본문 최소 노출 글자수 (기본: 1000)
  --require-public-image-figures N
                  공개 페이지 검증 시 image figure 최소 개수 요구 (기본: 0, 콘텐츠 정책 opt-in)
EOF
}

# ── 인자 파싱 ──
while [[ $# -gt 0 ]]; do
  case "$1" in
    --template)      TEMPLATE="$2"; shift 2;;
    --title)         TITLE="$2"; shift 2;;
    --article-title) ARTICLE_TITLE="$2"; shift 2;;
    --body-file)     BODY_FILE="$2"; shift 2;;
    --category)      CATEGORY="$2"; shift 2;;
    --tags)          TAGS="$2"; shift 2;;
    --banner)        BANNER="$2"; shift 2;;
    --banner-alt)    BANNER_ALT="$2"; shift 2;;
    --blog)          BLOG="$2"; shift 2;;
    --helper)        HELPER="$2"; shift 2;;
    --cdp-port)      CDP_PORT="$2"; shift 2;;
    --seo-check)     SEO_CHECK="$2"; shift 2;;
    --seo-keyword)   SEO_KEYWORD="$2"; shift 2;;
    --seo-min-body-chars) SEO_MIN_BODY_CHARS="$2"; shift 2;;
    --require-public-image-figures) REQUIRE_PUBLIC_IMAGE_FIGURES="$2"; shift 2;;
    --private)       PRIVATE=true; shift;;
    -h|--help)       usage; exit 0;;
    *) echo "Unknown option: $1" >&2; usage; exit 1;;
  esac
done

# ── 템플릿 preset ──
if [[ -n "$TEMPLATE" ]]; then
  case "$TEMPLATE" in
    mk-review)
      if [[ -n "$ARTICLE_TITLE" && -z "$TITLE" ]]; then
        DOW_KR=$(python3 -c "from datetime import datetime;d=datetime.now();dow='월화수목금토일';print(dow[d.weekday()])")
        DATE_PREFIX=$(date "+%Y.%m.%d(${DOW_KR})")
        TITLE="[매경] ${DATE_PREFIX} - ${ARTICLE_TITLE}"
      fi
      [[ -z "$CATEGORY" ]] && CATEGORY="재테크 이야기/경제신문 리뷰"
      [[ -z "$BLOG" ]] && BLOG="anthropic.tistory.com"
      ;;
    daum-trends)
      [[ -z "$TAGS" ]] && TAGS="Daum,실시간트렌드,Daum-Trends"
      ;;
    simple-post) ;;
    *) fail "unknown template: $TEMPLATE" ;;
  esac
fi

# ── 필수값 검증 ──
[[ "$ALLOW_DIRECT_TISTORY_PUBLISH" != "1" ]] && fail "publish-post.sh must be called via approved wrapper (ALLOW_DIRECT_TISTORY_PUBLISH=1 required)"
[[ -z "$TITLE" ]]     && fail "--title required"
[[ -z "$BODY_FILE" ]] && fail "--body-file required"
[[ -z "$CATEGORY" ]]  && fail "--category required"
[[ ! -f "$BODY_FILE" ]] && fail "body file not found: $BODY_FILE"
[[ -n "$BANNER" && ! -f "$BANNER" ]] && fail "banner file not found: $BANNER"
[[ "$TEMPLATE" == "mk-review" && -z "$BANNER" ]] && fail "--banner required for template mk-review"
[[ ! "$REQUIRE_PUBLIC_IMAGE_FIGURES" =~ ^[0-9]+$ ]] && fail "--require-public-image-figures must be a non-negative integer"
[[ "$SEO_CHECK" != "off" && "$SEO_CHECK" != "warn" && "$SEO_CHECK" != "strict" ]] && fail "--seo-check must be off|warn|strict"
[[ ! "$SEO_MIN_BODY_CHARS" =~ ^[0-9]+$ ]] && fail "--seo-min-body-chars must be a non-negative integer"

# 배너가 있는데 alt가 없으면 제목을 alt로 사용 (빈 alt로 올라가는 것 방지)
if [[ -n "$BANNER" && -z "$BANNER_ALT" ]]; then
  BANNER_ALT="$TITLE"
fi

if [[ -z "$HELPER" ]]; then
  HELPER="$SCRIPT_DIR/tistory-editor-helpers.js"
fi
[[ ! -f "$HELPER" ]] && fail "helper JS not found: $HELPER"

# ── SEO 검사 (발행 전) ──
if [[ "$SEO_CHECK" != "off" ]]; then
  log "SEO 검사 실행 (mode=$SEO_CHECK)"
  SEO_ARGS=(--title "$TITLE" --body-file "$BODY_FILE" --mode "$SEO_CHECK" --min-body-chars "$SEO_MIN_BODY_CHARS")
  [[ -n "$TAGS" ]]        && SEO_ARGS+=(--tags "$TAGS")
  [[ -n "$SEO_KEYWORD" ]] && SEO_ARGS+=(--keyword "$SEO_KEYWORD")
  [[ -n "$BLOG" ]]        && SEO_ARGS+=(--blog "$BLOG")
  if ! python3 "$SCRIPT_DIR/seo_check.py" "${SEO_ARGS[@]}"; then
    fail "SEO check failed (mode=strict) — 위 error 항목을 수정 후 재발행"
  fi
fi

# ── 메인: Python Playwright CDP ──
log "Launching Playwright CDP publish (port=$CDP_PORT)"
DIRECT_NOTIFY_CHANNEL="${DIRECT_NOTIFY_CHANNEL:-}"
DIRECT_NOTIFY_ACCOUNT="${DIRECT_NOTIFY_ACCOUNT:-}"
DIRECT_NOTIFY_WORKFLOW="${DIRECT_NOTIFY_WORKFLOW:-}"
DIRECT_NOTIFY_AUTHOR="${DIRECT_NOTIFY_AUTHOR:-}"
PUBLISH_TRACE_FILE="${PUBLISH_TRACE_FILE:-}"
TISTORY_LOGIN_SCRIPT="${TISTORY_LOGIN_SCRIPT:-$SCRIPT_DIR/login.sh}"
TMP_STDERR="$(mktemp -t tistory-publish-stderr.XXXXXX)"

set +e
PYTHON_RESULT=$(TISTORY_LOGIN_SCRIPT="$TISTORY_LOGIN_SCRIPT" python3 - "$CDP_PORT" "$BLOG" "$TITLE" "$BODY_FILE" "$CATEGORY" "$TAGS" "$BANNER" "$HELPER" "$PRIVATE" "$REQUIRE_PUBLIC_IMAGE_FIGURES" "$TEMPLATE" "$BANNER_ALT" 2> >(tee "$TMP_STDERR" >&2) << 'PYTHON_SCRIPT'
import sys, json, time, os, re, subprocess, urllib.request, urllib.error
import html as htmlmod
from pathlib import Path
from urllib.parse import quote, urlsplit, urlunsplit

HARD_FAIL = None
ALLOW_MISSING_IMAGES = os.environ.get('ALLOW_MISSING_IMAGES', '').lower() in ('1','true','yes')  # legacy: downgrade opt-in image policy failures to warnings
RUN_TOKEN = os.environ.get('RUN_TOKEN', '').strip()

CDP_PORT   = sys.argv[1]
BLOG       = sys.argv[2]
TITLE      = sys.argv[3]
BODY_FILE  = sys.argv[4]
CATEGORY   = sys.argv[5]
TAGS_STR   = sys.argv[6]
BANNER     = sys.argv[7]
HELPER_JS  = sys.argv[8]
PRIVATE    = sys.argv[9] == "true"
REQUIRE_PUBLIC_IMAGE_FIGURES = int(sys.argv[10])
TEMPLATE   = sys.argv[11]
BANNER_ALT = sys.argv[12] if len(sys.argv) > 12 else ""

CDP_URL = f"http://127.0.0.1:{CDP_PORT}"
NEWPOST_URL = f"https://{BLOG}/manage/newpost/?type=post" if BLOG else "https://www.tistory.com/manage/newpost/?type=post"
POSTS_URL = f"https://{BLOG}/manage/posts/" if BLOG else "https://www.tistory.com/manage/posts/"

def normalize_public_base_url(base='', blog=''):
    value = (base or '').strip() or (blog or '').strip()
    if not value:
        return ''
    if '://' not in value:
        value = f"https://{value}"
    parts = urlsplit(value)
    if not parts.netloc:
        return ''
    return urlunsplit((parts.scheme or 'https', parts.netloc, '', '', '')).rstrip('/')

PUBLIC_BASE_URL = normalize_public_base_url(
    os.environ.get('TISTORY_PUBLIC_BASE_URL', ''),
    os.environ.get('TISTORY_PUBLIC_BLOG', ''),
)

def public_url_for(url):
    if not PUBLIC_BASE_URL or not url:
        return url
    try:
        parts = urlsplit(url)
    except Exception:
        return url
    if not parts.netloc or '/manage/' in parts.path:
        return url
    blog_host = (BLOG or '').lower()
    if blog_host and parts.netloc.lower() != blog_host:
        return url
    public_parts = urlsplit(PUBLIC_BASE_URL)
    return urlunsplit((public_parts.scheme, public_parts.netloc, parts.path, parts.query, parts.fragment))

def log(msg): print(f"[{time.strftime('%H:%M:%S')}] {msg}", file=sys.stderr)
def fail(msg):
    print(json.dumps({"success": False, "error": msg}))
    sys.exit(1)

def cdp_get_json(path, timeout=5):
    url = f"{CDP_URL}{path}"
    with urllib.request.urlopen(url, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))

def cdp_close_target(target_id, timeout=5):
    url = f"{CDP_URL}/json/close/{quote(target_id, safe='')}"
    with urllib.request.urlopen(url, timeout=timeout) as resp:
        return resp.read().decode("utf-8", errors="replace")

def is_target_newpost(url):
    if "newpost" not in (url or ""):
        return False
    if BLOG and f"https://{BLOG}/manage/newpost" not in url:
        return False
    return True

def cleanup_newpost_targets(reason):
    try:
        targets = cdp_get_json("/json/list")
    except Exception as e:
        log(f"  ⚠️ {reason}: cannot list CDP targets before attach: {type(e).__name__}: {e}")
        return 0

    closed = 0
    for target in targets:
        url = target.get("url") or ""
        target_id = target.get("id") or ""
        if not target_id or not is_target_newpost(url):
            continue
        try:
            cdp_close_target(target_id)
            closed += 1
            log(f"  - closed stale newpost target before attach: id={target_id}, url={url}")
        except Exception as e:
            log(f"  ⚠️ failed to close stale newpost target id={target_id}: {type(e).__name__}: {e}")
    return closed

OG_GATE_ENABLED = os.environ.get('TISTORY_OG_MATCH_GATE', '1').lower() not in ('0', 'false', 'no')
OG_VALIDATOR = os.environ.get('TISTORY_OG_VALIDATOR', '').strip()

def should_run_og_gate():
    return OG_GATE_ENABLED and bool(OG_VALIDATOR)

def run_og_gate(mode, *args):
    if not should_run_og_gate():
        return None
    validator = Path(OG_VALIDATOR)
    if not validator.exists():
        fail(f"OG validation gate unavailable: {validator}")
    cmd = [sys.executable, str(validator), mode]
    if mode == 'draft':
        cmd += ['--body-file', BODY_FILE]
    elif mode == 'public':
        cmd += ['--body-file', BODY_FILE, '--post-url', args[0]]
    else:
        fail(f"unknown OG validation mode: {mode}")
    proc = subprocess.run(cmd, text=True, capture_output=True, timeout=90)
    detail = (proc.stdout or proc.stderr or '').strip()
    if detail:
        log(f"  - OG {mode} gate: {detail[:1200]}")
    if proc.returncode != 0:
        fail(f"OG {mode} validation failed: {detail[:1000]}")
    try:
        return json.loads(proc.stdout.strip().splitlines()[-1])
    except Exception:
        return {"success": True, "raw": proc.stdout.strip()}


def write_debug_artifacts(page, prefix):
    try:
        base = os.environ.get('PUBLISH_TRACE_FILE') or f'/tmp/{prefix}'
        if base.endswith('.log'):
            base = base[:-4]
        html_path = f'{base}.{prefix}.html'
        png_path = f'{base}.{prefix}.png'
        try:
            Path(html_path).write_text(page.content(), encoding='utf-8')
            log(f"  - wrote html dump: {html_path}")
        except Exception as e:
            log(f"  ⚠️ html dump failed: {e}")
        try:
            page.screenshot(path=png_path, full_page=True)
            log(f"  - wrote screenshot: {png_path}")
        except Exception as e:
            log(f"  ⚠️ screenshot failed: {e}")
    except Exception as e:
        log(f"  ⚠️ debug artifact wrapper failed: {e}")

def norm_title(s):
    s = htmlmod.unescape(s or '')
    s = s.replace('&hellip;', '…')
    s = re.sub(r'\s+', ' ', s or '').strip()
    for ch in ['"', "'", '“', '”', '‘', '’']:
        s = s.replace(ch, '')
    return s

def same_title(a, b):
    return norm_title(a) == norm_title(b)

def mk_review_date_prefix(title):
    if TEMPLATE != 'mk-review':
        return None
    m = re.match(r'^(\[매경\]\s+\d{4}\.\d{2}\.\d{2}\([^)]*\))', norm_title(title))
    return m.group(1) if m else None

def same_mk_review_date(a, b):
    pa = mk_review_date_prefix(a)
    pb = mk_review_date_prefix(b)
    return bool(pa and pb and pa == pb)

def wait_tinymce(page, timeout_s=40):
    ready = False
    for _ in range(int(timeout_s / 2)):
        try:
            ready = page.evaluate("typeof tinymce !== 'undefined' && tinymce.activeEditor && tinymce.activeEditor.initialized")
        except Exception:
            ready = False
        if ready:
            return True
        time.sleep(2)
    return False

def run_login_recovery():
    cred = (os.environ.get('TISTORY_LOGIN_CRED_FILE') or os.environ.get('TISTORY_CRED_FILE') or '').strip()
    login_script = os.environ.get('TISTORY_LOGIN_SCRIPT', '').strip()
    if not cred:
        return False, 'missing TISTORY_LOGIN_CRED_FILE or TISTORY_CRED_FILE'
    if not login_script:
        return False, 'missing TISTORY_LOGIN_SCRIPT'
    try:
        cmd = ['bash', login_script, '--cred-file', cred]
        if BLOG:
            cmd += ['--blog', BLOG]
        if CDP_PORT:
            cmd += ['--cdp-port', CDP_PORT]
        proc = subprocess.run(
            cmd,
            text=True,
            capture_output=True,
            timeout=180,
        )
        ok = proc.returncode == 0
        detail = (proc.stdout or proc.stderr or '').strip()[:800]
        return ok, detail
    except Exception as e:
        return False, str(e)


def get_editor_state(page):
    try:
        return page.evaluate("""() => ({
            hasTinymce: typeof tinymce !== 'undefined',
            activeEditor: !!(typeof tinymce !== 'undefined' && tinymce.activeEditor),
            initialized: !!(typeof tinymce !== 'undefined' && tinymce.activeEditor && tinymce.activeEditor.initialized),
            textareaLength: document.getElementById('editor-tistory') ? document.getElementById('editor-tistory').value.length : -1,
            iframeCount: document.querySelectorAll('iframe').length,
            completeButtons: Array.from(document.querySelectorAll('button')).filter(b => (b.textContent || '').trim() === '완료').length,
            dialogOpen: !!document.querySelector('[role=dialog]'),
            url: location.href
        })""")
    except Exception as e:
        return {"error": str(e)}


def ensure_tinymce_ready(page, timeout_s=20, step_name='tinymce-check', allow_textarea_fallback=False, min_textarea_len=100):
    if wait_tinymce(page, timeout_s=timeout_s):
        return True
    state = get_editor_state(page)
    log(f"  ⚠️ {step_name}: tinymce unavailable, state={state}")
    if allow_textarea_fallback and state.get('textareaLength', -1) >= min_textarea_len:
        log(f"  - {step_name}: continuing with textarea fallback")
        return True
    return False

def open_attach_image_menu(page):
    page.evaluate("""(() => {
        const btns = document.querySelectorAll('[aria-label="첨부"]');
        for (const b of btns) {
            if (b.offsetParent !== null) { b.click(); return 'clicked-visible'; }
        }
        if (btns[0]) { btns[0].click(); return 'clicked-first'; }
        return 'not-found';
    })()""")
    time.sleep(0.5)

    selectors = [
        '#attach-image',
        '[role=menuitem]#attach-image',
        '[role=menuitem]:has-text("사진")',
    ]
    last_error = None
    for selector in selectors:
        try:
            item = page.locator(selector).first
            item.wait_for(state='attached', timeout=3000)
            try:
                item.click(timeout=3000)
                return
            except Exception as e:
                last_error = e
                item.click(timeout=3000, force=True)
                return
        except Exception as e:
            last_error = e

    clicked = page.evaluate("""(() => {
        const item =
            document.querySelector('#attach-image') ||
            Array.from(document.querySelectorAll('[role="menuitem"]'))
                .find(el => (el.textContent || '').includes('사진'));
        if (!item) return false;
        item.dispatchEvent(new MouseEvent('mousedown', {bubbles:true, cancelable:true, view:window}));
        item.dispatchEvent(new MouseEvent('mouseup', {bubbles:true, cancelable:true, view:window}));
        item.click();
        return true;
    })()""")
    if not clicked:
        raise RuntimeError(f"attach image menu item not clickable: {last_error}")

def focus_tag_input(page, tag_input):
    last_error = None
    try:
        tag_input.wait_for(state='attached', timeout=5000)
    except Exception as e:
        last_error = e

    for force in (False, True):
        try:
            tag_input.click(timeout=5000, force=force)
            return
        except Exception as e:
            last_error = e

    focused = page.evaluate("""(() => {
        const input = document.querySelector('#tagText');
        if (!input) return false;
        try { input.scrollIntoView({block:'center', inline:'center'}); } catch (e) {}
        try { input.click(); } catch (e) {}
        input.focus();
        return document.activeElement === input;
    })()""")
    if not focused:
        raise RuntimeError(f"tag input not focusable: {last_error}")

def enter_tag(page, tag_input, tag):
    focus_tag_input(page, tag_input)
    try:
        tag_input.fill('', timeout=5000)
    except Exception:
        page.evaluate("""(() => {
            const input = document.querySelector('#tagText');
            if (!input) return false;
            const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
            if (setter) setter.call(input, '');
            else input.value = '';
            input.dispatchEvent(new InputEvent('input', {bubbles:true, cancelable:true, inputType:'deleteContentBackward'}));
            input.focus();
            return true;
        })()""")

    typed = False
    try:
        tag_input.type(tag, delay=20, timeout=5000)
        typed = True
    except Exception:
        focus_tag_input(page, tag_input)
        try:
            page.keyboard.insert_text(tag)
            typed = True
        except Exception:
            typed = False
    if not typed:
        page.evaluate("""(tag) => {
            const input = document.querySelector('#tagText');
            if (!input) return false;
            const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
            if (setter) setter.call(input, tag);
            else input.value = tag;
            input.dispatchEvent(new InputEvent('input', {
                bubbles:true, cancelable:true, inputType:'insertText', data:tag
            }));
            input.focus();
            return true;
        }""", tag)

    try:
        tag_input.press('Enter', timeout=5000)
    except Exception:
        try:
            page.keyboard.press('Enter')
        except Exception:
            page.evaluate("""(() => {
                const input = document.querySelector('#tagText');
                if (!input) return false;
                input.focus();
                ['keydown', 'keypress', 'keyup'].forEach(type => {
                    input.dispatchEvent(new KeyboardEvent(type, {
                        key:'Enter', code:'Enter', keyCode:13, which:13, bubbles:true
                    }));
                });
                return true;
            })()""")

def click_complete_button(page):
    selectors = [
        '#publish-layer-btn',
        'button#publish-layer-btn',
        "button:has-text('완료')",
    ]
    last_error = None
    for selector in selectors:
        try:
            button = page.locator(selector).first
            button.wait_for(state='attached', timeout=5000)
            try:
                button.click(timeout=5000)
                return
            except Exception as e:
                last_error = e
                button.click(timeout=5000, force=True)
                return
        except Exception as e:
            last_error = e

    clicked = page.evaluate("""(() => {
        const button =
            document.querySelector('#publish-layer-btn') ||
            Array.from(document.querySelectorAll('button'))
                .find(btn => (btn.textContent || '').trim() === '완료');
        if (!button) return false;
        try { button.scrollIntoView({block:'center', inline:'center'}); } catch (e) {}
        try { button.focus(); } catch (e) {}
        button.dispatchEvent(new MouseEvent('mousedown', {bubbles:true, cancelable:true, view:window}));
        button.dispatchEvent(new MouseEvent('mouseup', {bubbles:true, cancelable:true, view:window}));
        button.click();
        return true;
    })()""")
    if not clicked:
        raise RuntimeError(f"complete button not clickable: {last_error}")

def click_publish_submit_button(page, private=False):
    selectors = []
    if private:
        selectors = [
            '#publish-btn',
            'button#publish-btn',
            '[role="dialog"] button:has-text("비공개 저장")',
            '[role="dialog"] button:has-text("저장")',
        ]
    else:
        selectors = [
            '#publish-btn',
            'button#publish-btn',
            '[role="dialog"] button:has-text("공개 발행")',
            '[role="dialog"] button:has-text("발행")',
        ]

    last_error = None
    for selector in selectors:
        try:
            button = page.locator(selector).first
            button.wait_for(state='attached', timeout=5000)
            try:
                button.click(timeout=5000)
                return {'clicked': True, 'clickMethod': f'playwright:{selector}'}
            except Exception as e:
                last_error = e
                button.click(timeout=5000, force=True)
                return {'clicked': True, 'clickMethod': f'playwright-force:{selector}'}
        except Exception as e:
            last_error = e

    result = page.evaluate("""(privateMode) => {
        const dialog = document.querySelector('[role="dialog"]') || document;
        const btns = Array.from(dialog.querySelectorAll('button'));
        const btn = btns.find(b => {
            const t = (b.textContent || '').trim();
            if (privateMode) return t.includes('비공개 저장') || t === '저장';
            return t.includes('공개 발행') || t === '발행' || t.includes('발행하기') || t === 'Publish';
        }) || document.querySelector('#publish-btn');
        if (!btn) return {clicked:false, text:null};
        try { btn.scrollIntoView({block:'center', inline:'center'}); } catch (e) {}
        try { btn.focus(); } catch (e) {}
        btn.dispatchEvent(new MouseEvent('mousedown', {bubbles:true, cancelable:true, view:window}));
        btn.dispatchEvent(new MouseEvent('mouseup', {bubbles:true, cancelable:true, view:window}));
        btn.click();
        return {
            clicked:true,
            clickMethod:'dom-events',
            text:(btn.textContent || '').trim(),
            disabled:!!btn.disabled,
            ariaDisabled:btn.getAttribute('aria-disabled'),
            className:btn.className || ''
        };
    }""", private)
    if not result.get('clicked'):
        raise RuntimeError(f"publish submit button not clickable: {last_error}")
    return result

def debug_newpost_state(page):
    try:
        return page.evaluate("""() => {
            const buttons = Array.from(document.querySelectorAll('button')).map(b => ({
                text: (b.textContent || '').trim(),
                disabled: !!b.disabled,
                className: b.className || ''
            })).filter(b => b.text).slice(0, 30);
            const titleEl = document.querySelector('input[placeholder*="제목"], textarea[placeholder*="제목"], input[name="title"]');
            const categoryText = Array.from(document.querySelectorAll('button, [role="button"], .txt_category, .category')).map(el => (el.textContent || '').trim()).filter(Boolean).slice(0, 20);
            return {
                url: location.href,
                titleValue: titleEl ? (titleEl.value || '') : null,
                textareaLength: document.getElementById('editor-tistory') ? document.getElementById('editor-tistory').value.length : -1,
                buttons,
                categoryText,
                hasDialog: !!document.querySelector('[role="dialog"]')
            };
        }""")
    except Exception as e:
        return {"error": str(e)}

def get_dialog_state(page):
    try:
        return page.evaluate("""() => {
            const dialog = document.querySelector('[role="dialog"]');
            const buttons = Array.from(document.querySelectorAll('button')).map(b => ({
                text: (b.textContent || '').trim(),
                disabled: !!b.disabled,
                ariaDisabled: b.getAttribute('aria-disabled'),
                className: b.className || '',
            })).filter(b => b.text);
            const dialogButtons = dialog ? Array.from(dialog.querySelectorAll('button')).map(b => ({
                text: (b.textContent || '').trim(),
                disabled: !!b.disabled,
                ariaDisabled: b.getAttribute('aria-disabled'),
                className: b.className || '',
            })).filter(b => b.text) : [];
            const radios = dialog ? Array.from(dialog.querySelectorAll('input[type="radio"]')).map(r => ({value: r.value, checked: !!r.checked, disabled: !!r.disabled})) : [];
            const invalids = dialog ? Array.from(dialog.querySelectorAll('[aria-invalid="true"], .error, .txt_error, .invalid, .field_error')).map(el => (el.textContent || '').trim()).filter(Boolean).slice(0, 10) : [];
            const publishBtn = dialog ? Array.from(dialog.querySelectorAll('button')).find(b => ((b.textContent || '').trim().includes('공개 발행') || (b.textContent || '').trim() === '발행')) : null;
            return {
                url: location.href,
                hasDialog: !!dialog,
                dialogText: dialog ? (dialog.textContent || '').slice(0, 300) : '',
                dialogButtons,
                buttons,
                radios,
                invalids,
                publishBtn: publishBtn ? {
                    text: (publishBtn.textContent || '').trim(),
                    disabled: !!publishBtn.disabled,
                    ariaDisabled: publishBtn.getAttribute('aria-disabled'),
                    className: publishBtn.className || '',
                } : null,
            };
        }""")
    except Exception as e:
        return {"error": str(e)}

def list_recent_posts(page, navigate=True):
    if "/manage/posts" not in page.url:
        if not navigate:
            return []
        page.goto(POSTS_URL, wait_until="domcontentloaded", timeout=30000)
        time.sleep(1)
    return page.evaluate("""() =>
        Array.from(document.querySelectorAll('strong a[href*="tistory.com/"]')).slice(0, 30).map(a => ({
            href: a.href,
            text: (a.textContent || '').trim()
        }))
    """)

def find_latest_post(page, title_hint, before_posts=None, timeout_s=60):
    hint = norm_title(title_hint)
    before_hrefs = set((p.get('href') or '') for p in (before_posts or []))
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        posts = list_recent_posts(page)
        if posts:
            exact_new = []
            exact_any = []
            for post in posts:
                href = post.get('href', '')
                text = norm_title(post.get('text', ''))
                is_new = href not in before_hrefs
                if text == hint:
                    if is_new:
                        exact_new.append(post)
                    exact_any.append(post)
            target = exact_new[0] if exact_new else (exact_any[0] if exact_any else None)
            if target:
                m = re.search(r'/([0-9]+)$', target.get('href', ''))
                if m:
                    return {"id": m.group(1), "url": target['href'], "text": target['text']}
        time.sleep(2)
    return None

def find_public_post_by_rss(title_hint, timeout_s=30, match_date_prefix=False):
    if not BLOG:
        return None
    import urllib.request
    import xml.etree.ElementTree as ET
    rss_url = f"https://{BLOG}/rss"
    deadline = time.time() + timeout_s
    last_error = None
    while time.time() < deadline:
        try:
            req = urllib.request.Request(rss_url, headers={'User-Agent': 'Mozilla/5.0'})
            raw = urllib.request.urlopen(req, timeout=10).read()
            root = ET.fromstring(raw)
            for item in root.findall('./channel/item'):
                title = item.findtext('title') or ''
                link = item.findtext('link') or ''
                matched = same_title(title, title_hint) or (match_date_prefix and same_mk_review_date(title, title_hint))
                if matched and link:
                    m = re.search(r'/([0-9]+)$', link)
                    return {'id': m.group(1) if m else None, 'url': link, 'text': title, 'source': 'rss'}
        except Exception as e:
            last_error = e
        time.sleep(2)
    if last_error:
        log(f"  ⚠️ RSS publish confirmation failed: {last_error}")
    return None

def find_manage_post_by_title(context, title_hint, match_date_prefix=False):
    if not BLOG:
        return None
    manage_page = context.new_page()
    try:
        manage_page.goto(POSTS_URL, wait_until="domcontentloaded", timeout=30000)
        time.sleep(1)
        posts = list_recent_posts(manage_page, navigate=False)
        for post in posts:
            matched = same_title(post.get('text', ''), title_hint) or (match_date_prefix and same_mk_review_date(post.get('text', ''), title_hint))
            if matched:
                href = post.get('href') or ''
                m = re.search(r'/([0-9]+)$', href)
                return {
                    'id': m.group(1) if m else None,
                    'url': href,
                    'text': post.get('text', ''),
                    'source': 'manage-posts',
                }
    finally:
        try:
            manage_page.close()
        except Exception:
            pass
    return None

def assert_no_duplicate_title_before_publish(context, title_hint):
    if not BLOG:
        log("  - duplicate preflight skipped: BLOG not set")
        return None
    match_date_prefix = TEMPLATE == 'mk-review'
    existing = find_public_post_by_rss(title_hint, timeout_s=4, match_date_prefix=match_date_prefix)
    if existing:
        reason = 'same date prefix' if match_date_prefix and same_mk_review_date(existing.get('text', ''), title_hint) and not same_title(existing.get('text', ''), title_hint) else 'same title'
        fail(f"duplicate preflight failed: existing public post {existing.get('url')} ({existing.get('source')}, {reason})")
    try:
        existing = find_manage_post_by_title(context, title_hint, match_date_prefix=match_date_prefix)
    except Exception as e:
        log(f"  ⚠️ duplicate preflight manage-posts check failed: {e}")
        existing = None
    if existing:
        reason = 'same date prefix' if match_date_prefix and same_mk_review_date(existing.get('text', ''), title_hint) and not same_title(existing.get('text', ''), title_hint) else 'same title'
        fail(f"duplicate preflight failed: existing managed post {existing.get('url')} ({existing.get('source')}, {reason})")
    log("  - duplicate preflight: no existing post with same title/date prefix")
    return None

def confirm_public_publish(page, title_hint, before_posts=None, timeout_s=30):
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        try:
            current_url = page.url
            if "/manage/posts" in current_url or re.search(r'https://[^/]+/entry/[^/?#]+', current_url):
                latest = find_latest_post(page, title_hint, before_posts=before_posts, timeout_s=4)
                return latest or {'id': None, 'url': current_url, 'text': title_hint, 'source': 'navigation'}
        except Exception as e:
            log(f"  ⚠️ navigation publish confirmation skipped: {e}")

        # Public RSS is checked before navigating away from the editor. If Tistory already
        # created the post but left the editor dialog stuck with an alert, this confirms
        # success without discarding the still-open editor state.
        rss_post = find_public_post_by_rss(title_hint, timeout_s=4)
        if rss_post:
            return rss_post

        try:
            latest = find_latest_post(page, title_hint, before_posts=before_posts, timeout_s=4)
            if latest:
                latest['source'] = latest.get('source') or 'manage-posts'
                return latest
        except Exception as e:
            log(f"  ⚠️ manage-posts publish confirmation skipped: {e}")
        time.sleep(1)
    return None

def republish_current_editor(page, private):
    ensure_tinymce_ready(page, timeout_s=10, step_name='republish', allow_textarea_fallback=True, min_textarea_len=100)
    page.evaluate("typeof cleanupOGResiduals === 'function' ? cleanupOGResiduals() : null")
    page.evaluate("typeof tinymce !== 'undefined' && tinymce.activeEditor ? (tinymce.activeEditor.save(), 'ok') : 'no-tinymce'")
    click_complete_button(page)
    time.sleep(2)

    for _ in range(10):
        try:
            dlg = page.evaluate("document.querySelector('[role=dialog]') ? 'yes' : 'no'")
        except Exception:
            dlg = 'yes'
        if dlg == 'yes':
            break
        time.sleep(1)

    if private:
        try:
            page.evaluate("""(() => {
                const r = document.querySelector('input[type=radio][value="0"]');
                if (r) { r.click(); r.checked = true; r.dispatchEvent(new Event('change', {bubbles:true})); }
            })()""")
            time.sleep(0.5)
            page.evaluate("""(() => {
                const btns = document.querySelectorAll('button');
                for (const b of btns) { if (b.textContent.includes('비공개 저장')) { b.click(); return; } }
            })()""")
        except Exception:
            return True

        for _ in range(20):
            try:
                if "/manage/posts" in page.url:
                    return True
                dlg_gone = page.evaluate("document.querySelector('[role=dialog]') ? 'open' : 'closed'")
                if dlg_gone == 'closed':
                    return True
            except Exception:
                return True
            time.sleep(1)
        return False
    else:
        try:
            page.evaluate("""(() => {
                const r = document.querySelector('input[type=radio][value="20"]');
                if (r) { r.click(); r.checked = true; r.dispatchEvent(new Event('change', {bubbles:true})); }
            })()""")
            time.sleep(0.5)
            page.evaluate("""(() => {
                const btns = document.querySelectorAll('button');
                for (const b of btns) { if (b.textContent.includes('공개 발행')) { b.click(); return; } }
            })()""")
        except Exception:
            return True

        for _ in range(20):
            try:
                if "/manage/posts" in page.url:
                    return True
            except Exception:
                return True
            time.sleep(1)
        return True

def inspect_gap(page, post_url):
    probe = page.context.new_page()
    try:
        probe.goto(post_url, wait_until="domcontentloaded", timeout=30000)
        time.sleep(2)
        return probe.evaluate("""() => {
            const fig = document.querySelector('figure[data-ke-type="opengraph"]');
            const next = fig?.nextElementSibling;
            const next2 = next?.nextElementSibling;
            return {
                nextOuter: next?.outerHTML || null,
                next2Outer: next2?.outerHTML || null,
                gapPersists: !!(next && next.tagName === 'P' && ((next.innerHTML || '').trim() === '&nbsp;' || (next.textContent || '').replace(/[\u00a0\u200b\s]/g, '') === ''))
            };
        }""")
    finally:
        try:
            probe.close()
        except Exception:
            pass

from playwright.sync_api import sync_playwright, TimeoutError as PwTimeout
import fcntl, atexit

# ── Publish lock ──────────────────────────────────────────────────────────
# Prevents concurrent publish jobs on the same blog/CDP browser from
# interfering with each other (e.g. closing the other run's editor page).

class PublishLock:
    def __init__(self):
        self._fd = None
        self._path = None
        enabled = os.environ.get('TISTORY_PUBLISH_LOCK', '1') == '1'
        if not enabled:
            return
        key = BLOG if BLOG else f"cdp-{CDP_PORT}"
        key = re.sub(r'[^a-zA-Z0-9._-]', '_', key)
        self._path = f"/tmp/tistory-publish-{key}.lock"

    def acquire(self):
        if not self._path:
            log("Publish lock: disabled (TISTORY_PUBLISH_LOCK=0)")
            return
        timeout = int(os.environ.get('TISTORY_PUBLISH_LOCK_TIMEOUT_SECONDS', '1200'))
        mode = os.environ.get('TISTORY_PUBLISH_LOCK_MODE', 'wait')
        log(f"Publish lock: waiting ({self._path}, mode={mode}, timeout={timeout}s)")
        self._fd = open(self._path, 'w')
        if mode == 'fail':
            try:
                fcntl.flock(self._fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except (IOError, OSError):
                self._fd.close()
                self._fd = None
                fail("publish/lock-busy: another publish job holds the lock")
        else:
            deadline = time.time() + timeout
            while True:
                try:
                    fcntl.flock(self._fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    break
                except (IOError, OSError):
                    if time.time() >= deadline:
                        self._fd.close()
                        self._fd = None
                        fail(f"publish/lock-timeout: waited {timeout}s for {self._path}")
                    time.sleep(1)
        log(f"Publish lock: acquired ({self._path})")

    def release(self):
        if self._fd:
            try:
                fcntl.flock(self._fd, fcntl.LOCK_UN)
                self._fd.close()
                log(f"Publish lock: released ({self._path})")
            except Exception as e:
                log(f"Publish lock: release error: {e}")
            self._fd = None

publish_lock = PublishLock()
atexit.register(publish_lock.release)

# ── TargetClosedError classification ──────────────────────────────────────
def _is_target_closed(exc):
    msg = str(exc)
    name = type(exc).__name__
    return (name == 'TargetClosedError'
            or 'Target page, context or browser has been closed' in msg
            or 'Target closed' in msg)

_orig_excepthook = sys.excepthook
def _classify_excepthook(etype, evalue, etb):
    publish_lock.release()
    if _is_target_closed(evalue):
        print(json.dumps({
            "success": False,
            "error": "publish/target-closed",
            "detail": str(evalue),
            "hint": "Concurrent publish job may have closed the page, or the browser was shut down externally.",
        }))
        sys.exit(1)
    _orig_excepthook(etype, evalue, etb)
sys.excepthook = _classify_excepthook

start = time.time()
last_dialog_message = None
body_html = open(BODY_FILE, 'r', encoding='utf-8').read()
draft_og_gate = None
public_og_gate = None

if should_run_og_gate():
    log("Preflight: OG URL/title validation")
    draft_og_gate = run_og_gate('draft')
    log(f"  - OG draft gate OK ({draft_og_gate.get('count', 0)} cards)")

def handle_dialog(dialog):
    global last_dialog_message
    try:
        payload = {"type": dialog.type, "message": dialog.message}
        last_dialog_message = payload
        log(f"  - browser dialog: {payload}")
        msg = (dialog.message or '').strip()
        if dialog.type == 'confirm' and '이어서 작성하시겠습니까?' in msg:
            dialog.dismiss()
            log("  - browser dialog action: dismiss draft recovery")
        else:
            dialog.accept()
            log("  - browser dialog action: accept")
    except Exception as e:
        log(f"  ⚠️ dialog handler failed: {e}")

publish_lock.acquire()

log('Preflight: stale newpost target cleanup')
closed_targets = cleanup_newpost_targets('stale newpost target cleanup')
log(f"Preflight: stale newpost target cleanup OK (closed={closed_targets})")

with sync_playwright() as p:
    log('Preflight: Playwright CDP attach')
    browser = p.chromium.connect_over_cdp(CDP_URL)
    log('Preflight: attach OK')

    # ── Step 1: 새 글 페이지 열기 ──
    log("Step 1: 새 글 페이지 열기")
    # 기존 newpost 탭 재사용 금지. 같은 브라우저 세션의 이전 글 상태가 섞이는 걸 막는다.
    # Lock 획득 후에도 같은 CDP에서 다른 블로그가 열려 있을 수 있으므로 현재 BLOG의 newpost만 닫는다.
    for ctx in browser.contexts:
        for pg in list(ctx.pages):
            try:
                pg_url = pg.url or ""
                if "newpost" not in pg_url:
                    continue
                if BLOG and f"https://{BLOG}/manage/newpost" not in pg_url:
                    continue
                pg.close()
            except Exception:
                pass

    ctx0 = browser.contexts[0] if browser.contexts else browser.new_context()
    page = ctx0.new_page()
    page.on('dialog', handle_dialog)
    log(f"  - target newpost url: {NEWPOST_URL}")
    try:
        resp = page.goto(NEWPOST_URL, wait_until="domcontentloaded", timeout=30000)
        status = None
        try:
            status = resp.status if resp else None
        except Exception:
            status = None
        title_now = ''
        try:
            title_now = page.title()
        except Exception:
            pass
        log(f"  - after goto: url={page.url}, status={status}, title={title_now}")
    except Exception as e:
        title_now = ''
        try:
            title_now = page.title()
        except Exception:
            pass
        log(f"  ❌ Step 1 goto exception: type={type(e).__name__}, error={e}")
        log(f"  - page state on failure: url={getattr(page, 'url', None)}, title={title_now}")
        write_debug_artifacts(page, 'step1-failed')
        fail(f"Step 1 newpost goto failed: {type(e).__name__}: {e}")

    # 로그인 세션 확인
    _login_domains = ["auth/login", "accounts.kakao.com", "logins.daum.net", "kauth.kakao.com"]
    if any(x in page.url for x in _login_domains):
        log(f"  ⚠️ login redirect detected: {page.url}")
        write_debug_artifacts(page, 'step1-login-redirect')
        login_ok, login_detail = run_login_recovery()
        log(f"  - login recovery attempted: ok={login_ok}, detail={login_detail}")
        if login_ok:
            try:
                resp = page.goto(NEWPOST_URL, wait_until="domcontentloaded", timeout=30000)
                status = None
                try:
                    status = resp.status if resp else None
                except Exception:
                    status = None
                title_now = ''
                try:
                    title_now = page.title()
                except Exception:
                    pass
                log(f"  - after login recovery goto: url={page.url}, status={status}, title={title_now}")
            except Exception as e:
                write_debug_artifacts(page, 'step1-post-login-goto-failed')
                fail(f"Step 1 post-login goto failed: {type(e).__name__}: {e}")
        if any(x in page.url for x in _login_domains):
            fail(f"카카오 로그인 세션 만료. login.sh 자동 복구 후에도 로그인 페이지 유지됨. (redirected: {page.url})")

    # TinyMCE 대기
    log("  - tinymce 대기...")
    for i in range(20):
        ready = page.evaluate("typeof tinymce !== 'undefined' && tinymce.activeEditor && tinymce.activeEditor.initialized")
        if ready:
            break
        time.sleep(2)
    if not ready:
        fail("tinymce not ready after 40s")
    # 에디터 초기화 검증
    stale_state = page.evaluate("""() => ({
        title: (document.getElementById('post-title-inp')?.textContent || '').trim(),
        bodyLength: typeof tinymce !== 'undefined' && tinymce.activeEditor ? tinymce.activeEditor.getContent().length : -1,
        ogCount: typeof tinymce !== 'undefined' && tinymce.activeEditor ? tinymce.activeEditor.getBody().querySelectorAll('figure[data-ke-type=\"opengraph\"], [data-og-placeholder]').length : -1,
        imageCount: typeof tinymce !== 'undefined' && tinymce.activeEditor ? tinymce.activeEditor.getBody().querySelectorAll('figure[data-ke-type=\"image\"]').length : -1
    })""")
    log(f"  - editor initial state: {stale_state}")
    if stale_state.get('title') or (stale_state.get('bodyLength', 0) > 20) or (stale_state.get('ogCount', 0) > 0) or (stale_state.get('imageCount', 0) > 0):
        fail(f"editor not clean at start: {stale_state}")
    log("Step 1: 완료")

    # ── Helper JS 주입 (addScriptTag — CSP 우회) ──
    log("Injecting helper JS...")
    page.add_script_tag(path=HELPER_JS)
    time.sleep(1)
    if not page.evaluate("typeof insertContent === 'function'"):
        fail("helper JS injection failed")

    # ── Step 2: 카테고리 & 제목 ──
    log("Step 2: 카테고리 & 제목")
    page.evaluate("document.getElementById('category-btn').click()")
    time.sleep(0.5)
    cat_result = page.evaluate(f"""(() => {{
        const rawName = {json.dumps(CATEGORY)};
        const target = rawName.trim();
        const targetLeaf = target.split('/').pop().trim();
        const opts = document.querySelectorAll('[role=option]');
        for (const o of opts) {{
            const t = o.textContent.trim();
            const leaf = t.replace(/^-\\s*/, '').trim();
            if (
                t === target ||
                leaf === target ||
                t.includes(target) ||
                leaf.includes(target) ||
                leaf === targetLeaf ||
                leaf.includes(targetLeaf)
            ) {{
                o.click();
                return 'ok: ' + t;
            }}
        }}
        return 'not found: ' + Array.from(opts).map(o => o.textContent.trim()).join('|');
    }})()""")
    if not cat_result.startswith("ok"):
        fail(f"category select failed: {cat_result}")

    final_title = TITLE if not RUN_TOKEN else f"{TITLE} [{RUN_TOKEN}]"
    page.evaluate(f"""(() => {{
        const t = document.getElementById('post-title-inp');
        if (!t) return 'no el';
        t.textContent = {json.dumps(final_title)};
        t.dispatchEvent(new Event('input', {{bubbles:true}}));
        return 'ok';
    }})()""")
    log(f"Step 2: 완료 (title={final_title})")

    # ── Step 3: 본문 삽입 ──
    log("Step 3: 본문 삽입")
    if not ensure_tinymce_ready(page, timeout_s=20, step_name='step3'):
        fail('tinymce unavailable before content insert')
    page.evaluate("""(html) => {
        if (typeof tinymce === 'undefined' || !tinymce.activeEditor) return 'no-tinymce';
        tinymce.activeEditor.setContent(html);
        tinymce.activeEditor.setDirty(true);
        tinymce.activeEditor.save();
        return 'ok';
    }""", body_html)

    content_len = page.evaluate("typeof tinymce !== 'undefined' && tinymce.activeEditor ? tinymce.activeEditor.getContent().length : -1")
    log(f"  - content length: {content_len}")
    if content_len < 100:
        fail(f"body too short ({content_len})")
    log("Step 3: 완료")

    # ── Step 3.5: inline 이미지 업로드 + marker 이동 ──
    image_files = []
    image_files_env = os.environ.get('TISTORY_INLINE_IMAGE_FILES', '').strip()
    inline_image_caption = os.environ.get('TISTORY_INLINE_IMAGE_CAPTION', '').strip()
    if image_files_env:
        log("Step 3.5: inline 이미지 업로드")
        image_files = [p for p in image_files_env.split(':') if p]
        marker_names = [f'trend-image-{i+1}' for i in range(len(image_files))]
        try:
            page.evaluate("typeof uploadInlineImages === 'function' && typeof moveImagesToMarkers === 'function'")
            mapping = []
            for idx, img_path in enumerate(image_files):
                open_attach_image_menu(page)
                time.sleep(0.5)
                fi = page.query_selector('#openFile')
                if not fi:
                    fail('inline image file input not found')
                fi.set_input_files(img_path)
                time.sleep(4)
                debug_blocks = page.evaluate("typeof debugImageBlocks === 'function' ? debugImageBlocks() : []")
                log(f"  - inline image {idx+1}/{len(image_files)} blocks: {debug_blocks}")
                item = {"marker": marker_names[idx], "filename": os.path.basename(img_path)}
                if inline_image_caption:
                    item["caption"] = inline_image_caption
                mapping.append(item)
            moved = page.evaluate("(mapping) => moveImagesToMarkers(mapping)", mapping)
            log(f"  - inline image mapping results: {moved}")
            comic_display_width = int(os.environ.get('DAUM_TRENDS_COMIC_DISPLAY_WIDTH', '680'))
            comic_presentation = page.evaluate(
                """
                ({width}) => {
                  const editor = tinymce?.activeEditor;
                  if (!editor || !editor.getBody) return {success:false, error:'tinymce unavailable'};
                  const body = editor.getBody();
                  const figures = Array.from(body.querySelectorAll('figure[data-ke-type="image"]'));
                  const changed = [];
                  for (const figure of figures) {
                    const img = figure.querySelector('img');
                    const filename = img?.getAttribute('data-filename') || '';
                    if (!/^00-comic\.(jpe?g|png|webp)$/i.test(filename)) continue;
                    figure.setAttribute('data-ke-style', 'alignLeft');
                    figure.classList?.remove('alignCenter', 'alignRight');
                    figure.classList?.add('alignLeft');
                    figure.style.textAlign = 'left';
                    figure.style.width = `${width}px`;
                    figure.style.maxWidth = '100%';
                    if (img) {
                      img.setAttribute('width', String(width));
                      img.style.width = `${width}px`;
                      img.style.maxWidth = '100%';
                      img.style.height = 'auto';
                    }
                    changed.push({filename, width});
                  }
                  editor.setDirty(true);
                  editor.fire('change');
                  editor.save();
                  const cm = document.querySelector('.CodeMirror');
                  if (cm && cm.CodeMirror) cm.CodeMirror.setValue(editor.getContent());
                  document.querySelectorAll('textarea').forEach(t => { if (t.value.length > 100) t.value = editor.getContent(); });
                  return {success:true, changed};
                }
                """,
                {"width": comic_display_width},
            )
            log(f"  - Daum comic presentation result: {comic_presentation}")
            image_debug = page.evaluate("() => ({ markers: Array.from(tinymce.activeEditor.getBody().querySelectorAll('[data-image-marker]')).length, figures: Array.from(tinymce.activeEditor.getBody().querySelectorAll('figure[data-ke-type=\"image\"]')).length, contentLength: tinymce.activeEditor.getContent().length })")
            log(f"  - inline image editor state: {image_debug}")
            marker_figures = page.evaluate("(filenames) => typeof collectUploadedImageFiguresByFilename === 'function' ? collectUploadedImageFiguresByFilename(filenames) : []", [os.path.basename(p) for p in image_files])
            log(f"  - inline image collected figures: {marker_figures}")
            missing = [item for item in marker_figures if not item.get('found')]
            if missing and page.evaluate("typeof rebuildContentWithImageFigures === 'function'"):
                rebuild_payload = []
                for idx, item in enumerate(marker_figures):
                    rebuild_payload.append({
                        'marker': marker_names[idx],
                        'outerHTML': item.get('outerHTML'),
                        'caption': inline_image_caption,
                    })
                rebuilt = page.evaluate("(payload) => rebuildContentWithImageFigures(payload)", rebuild_payload)
                log(f"  - inline image rebuild result: {rebuilt}")
                image_debug = page.evaluate("() => ({ markers: Array.from(tinymce.activeEditor.getBody().querySelectorAll('[data-image-marker]')).length, figures: Array.from(tinymce.activeEditor.getBody().querySelectorAll('figure[data-ke-type=\"image\"]')).length, contentLength: tinymce.activeEditor.getContent().length })")
                log(f"  - inline image editor state after rebuild: {image_debug}")
            if inline_image_caption:
                caption_debug = page.evaluate(
                    """
                    (caption) => {
                      const editor = tinymce?.activeEditor;
                      if (!editor || !editor.getBody) return {caption, matchingCaptions: 0, totalCaptions: 0};
                      const captions = Array.from(editor.getBody().querySelectorAll('figure[data-ke-type="image"] figcaption'));
                      return {
                        caption,
                        matchingCaptions: captions.filter((node) => node.textContent.trim() === caption).length,
                        totalCaptions: captions.length,
                      };
                    }
                    """,
                    inline_image_caption,
                )
                log(f"  - inline image caption state: {caption_debug}")
                if caption_debug.get('matchingCaptions', 0) < len(image_files):
                    fail(f"inline image caption count mismatch: expected {len(image_files)}, got {caption_debug.get('matchingCaptions', 0)}")
            log(f"  - inline image editor state: {image_debug}")
            try:
                collected = page.evaluate("typeof collectImageFiguresByFilename === 'function' ? collectImageFiguresByFilename() : []")
                log(f"  - inline image collected figures: {collected}")
            except Exception as e:
                log(f"  ⚠️ inline image collect failed: {e}")
            if image_debug.get('figures', 0) < len(image_files):
                fail(f"inline image figure count mismatch: expected {len(image_files)}, got {image_debug.get('figures', 0)}")
            log("Step 3.5: 완료")
        except Exception as e:
            import traceback
            log(f"  ⚠️ inline image exception repr: {repr(e)}")
            log(traceback.format_exc())
            fail(f"inline image upload failed: {e}")
    else:
        log("Step 3.5: inline 이미지 생략")

    # ── Step 4: 배너 업로드 ──
    if BANNER:
        log("Step 4: 배너 업로드")
        # visible한 첨부 버튼 찾기 — aria-label="첨부" 중 visible인 것
        uploaded = False
        try:
            # 메뉴 열기 (첨부 → 사진)
            open_attach_image_menu(page)
            time.sleep(0.5)
            fi = page.query_selector('#openFile')
            if fi:
                before_banner_image_count = page.evaluate("() => typeof tinymce !== 'undefined' && tinymce.activeEditor ? tinymce.activeEditor.getBody().querySelectorAll('img').length : 0")
                fi.set_input_files(BANNER)
                time.sleep(4)
                uploaded = True
                log("  - 배너 파일 전송 완료")
            else:
                log("  ⚠️ #openFile not found after menu open")
        except Exception as e:
            log(f"  ⚠️ 배너 업로드 실패: {e}")

        if uploaded and BANNER_ALT:
            try:
                alt_result = page.evaluate(
                    "({alt, filename, previousCount}) => typeof setImageAltForUploadedImage === 'function' ? setImageAltForUploadedImage(alt, filename, previousCount) : {success: false, error: 'setImageAltForUploadedImage unavailable'}",
                    {"alt": BANNER_ALT, "filename": os.path.basename(BANNER), "previousCount": before_banner_image_count},
                )
                log(f"  - 배너 alt 설정: {alt_result}")
            except Exception as e:
                log(f"  ⚠️ 배너 alt 설정 실패 (발행은 계속): {e}")

        if not uploaded:
            log("  ⚠️ 배너 업로드 실패 — 발행은 계속 진행")
        log(f"Step 4: {'완료' if uploaded else '⚠️ 미완료 (발행은 계속)'}")
    else:
        log("Step 4: 배너 생략")

    # ── Step 5: OG 카드 ──
    log("Step 5: OG 카드")
    og_urls = page.evaluate("typeof getOGPlaceholders === 'function' ? getOGPlaceholders() : []")
    log(f"  - OG URLs: {len(og_urls)}")
    for index, url in enumerate(og_urls, start=1):
        prep_result = page.evaluate("(url) => prepareOGPlaceholder(url)", url)
        if isinstance(prep_result, dict) and not prep_result.get("success", False):
            fail(f"OG placeholder preparation failed before publish: {json.dumps(prep_result, ensure_ascii=False)}")
        time.sleep(0.5)
        page.keyboard.press("Enter")
        og_status = {}
        for _ in range(8):
            time.sleep(1.5)
            og_status = page.evaluate(
                "(url) => typeof getOGCardStatus === 'function' ? getOGCardStatus(url) : {found: false, error: 'getOGCardStatus unavailable'}",
                url,
            )
            if og_status.get("found") and og_status.get("ogCardCount", 0) >= index:
                break
        log(f"  - OG [{url[:40]}...]: {json.dumps(og_status, ensure_ascii=False)}")
        if not og_status.get("found"):
            fail(f"OG card render failed before publish: {json.dumps(og_status, ensure_ascii=False)}")
    if og_urls:
        cleanup_result = page.evaluate("typeof cleanupOGResiduals === 'function' ? cleanupOGResiduals() : null")
        log(f"  - OG cleanup result: {cleanup_result}")
        if isinstance(cleanup_result, dict) and cleanup_result.get("ogCards") != len(og_urls):
            fail(f"OG card count mismatch before publish: expected {len(og_urls)}, got {cleanup_result.get('ogCards')}")
    log("Step 5: 완료")

    # ── Step 6: 대표이미지 ──
    if os.environ.get('TISTORY_SKIP_REPRESENT_IMAGE', '').lower() in ('1', 'true', 'yes'):
        log("Step 6: 대표이미지 생략")
    else:
        log("Step 6: 대표이미지")
        page.evaluate("typeof setRepresentImageFromEditor === 'function' && setRepresentImageFromEditor()")
        time.sleep(1)
        log("Step 6: 완료")

    # ── Step 7: 태그 ──
    if TAGS_STR:
        log("Step 7: 태그")
        tags = list(dict.fromkeys(t.strip() for t in TAGS_STR.split(',') if t.strip()))
        try:
            if page.is_closed():
                fail('page closed before tag step')
        except Exception:
            fail('page unavailable before tag step')

        try:
            live_state = debug_newpost_state(page)
            log(f"  - pre-tag state: {live_state}")
        except Exception as e:
            log(f"  ⚠️ pre-tag debug skipped: {e}")

        try:
            page.add_script_tag(path=HELPER_JS)
            time.sleep(0.3)
        except Exception as e:
            log(f"  ⚠️ helper reinject skipped: {e}")

        tag_input = page.locator('#tagText').first
        tag_input.wait_for(state='attached', timeout=5000)
        for tag in tags:
            enter_tag(page, tag_input, tag)
            time.sleep(0.35)

        chip_count = page.evaluate("document.querySelectorAll('.editor_tag .txt_tag').length")
        log(f"  - tag chips registered: {chip_count}/{len(tags)}")
        if chip_count < len(tags):
            registered_tags = page.evaluate("""() =>
                Array.from(document.querySelectorAll('.editor_tag .txt_tag'))
                    .map(el => (el.textContent || '').replace(/\\s*삭제\\s*$/, '').trim())
                    .filter(Boolean)
            """)
            missing_tags = [tag for tag in tags if tag not in registered_tags]
            if missing_tags:
                fallback_result = page.evaluate(
                    "(tags) => typeof setTags === 'function' ? setTags(tags) : {success:false,error:'setTags unavailable'}",
                    missing_tags,
                )
                log(f"  - tag helper fallback result: {fallback_result}")
                time.sleep(0.5)
                chip_count = page.evaluate("document.querySelectorAll('.editor_tag .txt_tag').length")
                log(f"  - tag chips after fallback: {chip_count}/{len(tags)}")
        if chip_count < len(tags):
            fail(f'tag registration incomplete: {chip_count}/{len(tags)}')
        log("Step 7: 완료")
    else:
        log("Step 7: 태그 생략")

    page.evaluate("typeof tinymce !== 'undefined' && tinymce.activeEditor ? (tinymce.activeEditor.save(), 'ok') : 'no-tinymce'")
    time.sleep(1)
    current_url = page.url
    if "/manage/posts" in current_url:
        log(f"  ⚠️ unexpected navigation before publish: {current_url}")
        page.goto(NEWPOST_URL, wait_until="domcontentloaded", timeout=30000)
        if not wait_tinymce(page, timeout_s=40):
            fail('tinymce not ready after unexpected navigation recovery')
        page.evaluate(f"""(html) => {{
            tinymce.activeEditor.setContent(html);
            tinymce.activeEditor.setDirty(true);
            tinymce.activeEditor.save();
        }}""", body_html)
        time.sleep(1)
        if og_urls:
            for index, url in enumerate(og_urls, start=1):
                prep_result = page.evaluate("(url) => prepareOGPlaceholder(url)", url)
                if isinstance(prep_result, dict) and not prep_result.get("success", False):
                    fail(f"recovery OG placeholder preparation failed before publish: {json.dumps(prep_result, ensure_ascii=False)}")
                time.sleep(0.5)
                page.keyboard.press("Enter")
                og_status = {}
                for _ in range(8):
                    time.sleep(1.5)
                    og_status = page.evaluate(
                        "(url) => typeof getOGCardStatus === 'function' ? getOGCardStatus(url) : {found: false, error: 'getOGCardStatus unavailable'}",
                        url,
                    )
                    if og_status.get("found") and og_status.get("ogCardCount", 0) >= index:
                        break
                log(f"  - recovery OG [{url[:40]}...]: {json.dumps(og_status, ensure_ascii=False)}")
                if not og_status.get("found"):
                    fail(f"recovery OG card render failed before publish: {json.dumps(og_status, ensure_ascii=False)}")
            cleanup_result = page.evaluate("typeof cleanupOGResiduals === 'function' ? cleanupOGResiduals() : null")
            log(f"  - recovery OG cleanup result: {cleanup_result}")
            if isinstance(cleanup_result, dict) and cleanup_result.get("ogCards") != len(og_urls):
                fail(f"recovery OG card count mismatch before publish: expected {len(og_urls)}, got {cleanup_result.get('ogCards')}")

    log("Step 7.5: 중복 제목 preflight")
    assert_no_duplicate_title_before_publish(ctx0, final_title)

    before_posts = list_recent_posts(page, navigate=False)
    log(f"  - before posts count: {len(before_posts)}")

    # ── Step 8: 발행 ──
    log("Step 8: 발행")
    # 이전 단계의 draft recovery confirm 등은 publish 결과 판정에 섞지 않는다.
    # 이후 publish 중 새로 발생한 alert/confirm은 handle_dialog가 다시 기록한다.
    last_dialog_message = None
    warning = None
    post_info = None
    gap_check = None
    # 발행 직전 OG 뒤 빈 문단 정리 1회 더 수행 (티스토리 직렬화 과정에서 재삽입되는 케이스 대응)
    step8_has_tinymce = wait_tinymce(page, timeout_s=20)
    if not step8_has_tinymce:
        state = get_editor_state(page)
        log(f"  ⚠️ step8: tinymce unavailable, state={state}")
    if step8_has_tinymce:
        final_cleanup = page.evaluate("typeof cleanupOGResiduals === 'function' ? cleanupOGResiduals() : null")
        log(f"  - final cleanup before publish: {final_cleanup}")
        # 발행 직전 save 재실행 (빈 본문 방지)
        save_state = page.evaluate("typeof tinymce !== 'undefined' && tinymce.activeEditor ? (tinymce.activeEditor.save(), 'ok') : 'no-tinymce'")
        log(f"  - pre-publish save state: {save_state}")
    else:
        log("  - step8 fallback: skip TinyMCE cleanup/save and rely on synced textarea")
    ta_len = page.evaluate("document.getElementById('editor-tistory') ? document.getElementById('editor-tistory').value.length : -1")
    log(f"  - textarea sync check: {ta_len}")
    if ta_len < 100:
        fail(f"textarea too short before publish ({ta_len})")

    try:
        pre_complete_state = debug_newpost_state(page)
        log(f"  - pre-complete state: {pre_complete_state}")
    except Exception as e:
        log(f"  ⚠️ pre-complete debug skipped: {e}")

    # 완료 버튼 — Tistory can leave it attached but not "stable" for Playwright.
    click_complete_button(page)
    time.sleep(2)
    try:
        post_complete_state = debug_newpost_state(page)
        log(f"  - post-complete state: {post_complete_state}")
    except Exception as e:
        log(f"  ⚠️ post-complete debug skipped: {e}")

    # 다이얼로그 대기
    for i in range(10):
        try:
            dlg = page.evaluate("document.querySelector('[role=dialog]') ? 'yes' : 'no'")
        except Exception as e:
            log(f"  - dialog wait interrupted: {e}")
            dlg = 'closed'
            break
        if dlg == 'yes':
            break
        time.sleep(1)
    if dlg != 'yes' and not PRIVATE:
        fail("publish dialog not found after 10s")

    dialog_state_before_submit = get_dialog_state(page)
    log(f"  - publish dialog state: {dialog_state_before_submit}")

    # 공개 선택 후 다이얼로그가 '공개 발행' 상태로 바뀔 때까지 먼저 대기
    if not PRIVATE:
        promoted = False
        for _ in range(10):
            preview_state = get_dialog_state(page)
            dialog_buttons = preview_state.get('dialogButtons') or []
            radios = preview_state.get('radios') or []
            if any(((b.get('text') if isinstance(b, dict) else b) == '공개 발행') for b in dialog_buttons) and any(r.get('value') == '20' and r.get('checked') for r in radios):
                promoted = True
                break
            page.evaluate("""(() => {
                const dialog = document.querySelector('[role="dialog"]') || document;
                const radio = dialog.querySelector('input[type="radio"][value="20"]');
                if (radio) {
                    radio.click();
                    radio.checked = true;
                    radio.dispatchEvent(new Event('click', {bubbles:true}));
                    radio.dispatchEvent(new Event('input', {bubbles:true}));
                    radio.dispatchEvent(new Event('change', {bubbles:true}));
                }
                const publicLabel = Array.from(dialog.querySelectorAll('label, .item_radio, button, div')).find(el => {
                    const t = (el.textContent || '').trim();
                    return t === '공개' || (t.startsWith('공개') && !t.includes('보호') && !t.includes('비공개') && !t.includes('공개 발행'));
                });
                if (publicLabel) {
                    try { publicLabel.click(); } catch (e) {}
                }
            })()""")
            time.sleep(0.5)
        log(f"  - public mode promoted: {promoted}, state={get_dialog_state(page)}")
        if not promoted:
            fail(f"public mode not activated in dialog: {get_dialog_state(page)}")
        page.evaluate("""(() => {
            const dialog = document.querySelector('[role="dialog"]') || document;
            const clickByText = (scope, texts) => {
                const nodes = Array.from(scope.querySelectorAll('button, label, .btn_date, .mce-btn-type1, .item_radio, .txt_date, .txt_public'));
                for (const node of nodes) {
                    const t = (node.textContent || '').trim();
                    if (texts.includes(t)) {
                        try { node.click(); return t; } catch (e) {}
                    }
                }
                return null;
            };
            const publicRadio = dialog.querySelector('input[type="radio"][value="20"]');
            if (publicRadio) {
                publicRadio.checked = true;
                publicRadio.dispatchEvent(new Event('input', {bubbles:true}));
                publicRadio.dispatchEvent(new Event('change', {bubbles:true}));
            }
            clickByText(dialog, ['공개']);
            clickByText(dialog, ['현재']);
        })()""")
        time.sleep(0.8)
        log(f"  - public mode normalized state: {get_dialog_state(page)}")

    if PRIVATE:
        page.evaluate("""(() => {
            const dialog = document.querySelector('[role="dialog"]') || document;
            const radio = dialog.querySelector('input[type="radio"][value="0"]');
            if (radio) {
                radio.click();
                radio.checked = true;
                radio.dispatchEvent(new Event('change', {bubbles:true}));
            }
        })()""")
        result = click_publish_submit_button(page, private=True)
    else:
        result = page.evaluate("""(() => {
            const dialog = document.querySelector('[role="dialog"]') || document;
            const afterRadios = Array.from(dialog.querySelectorAll('input[type="radio"]')).map(r => ({value: r.value, checked: !!r.checked}));
            const btns = Array.from(dialog.querySelectorAll('button'));
            const btn = btns.find(b => {
                const t = (b.textContent || '').trim();
                return t.includes('공개 발행') || t == '발행' || t.includes('발행하기') || t == 'Publish';
            });
            if (!btn) return {clicked: false, text: null, radios: afterRadios};
            try { btn.scrollIntoView({ block: 'center', inline: 'center' }); } catch (e) {}
            try { btn.focus(); } catch (e) {}
            return {
                clicked: false,
                readyForNativeClick: true,
                text: (btn.textContent || '').trim(),
                radios: afterRadios,
                disabled: !!btn.disabled,
                ariaDisabled: btn.getAttribute('aria-disabled'),
                className: btn.className || '',
            };
        })()""")
        if result.get('readyForNativeClick'):
            click_result = click_publish_submit_button(page, private=False)
            result.update(click_result)
    log(f"  - submit click result: {result}")
    if not result.get('clicked'):
        fail(f"publish submit button not found: {get_dialog_state(page)}")

    # 완료 대기 — 공개: manage/posts 또는 entry 이동 / 비공개: 다이얼로그 닫힘
    time.sleep(3)
    try:
        log(f"  - post-submit immediate state: {get_dialog_state(page)}")
    except Exception as e:
        log(f"  - post-submit immediate state skipped: {e}")
    if last_dialog_message:
        log(f"  - browser dialog before publish wait: {last_dialog_message}")
    if PRIVATE:
        # 비공개 저장은 manage/posts 리다이렉트, 다이얼로그 닫힘, 페이지 교체/닫힘을 모두 성공 경로로 본다.
        private_saved = False
        dlg_gone = 'open'
        for i in range(15):
            try:
                current_url = page.url
                log(f"  - private wait[{i}] url={current_url}")
            except Exception as e:
                log(f"  - private wait[{i}] page unavailable: {e}")
                private_saved = True
                dlg_gone = 'page-closed'
                break
            if "/manage/posts" in current_url:
                private_saved = True
                dlg_gone = 'redirected'
                break
            try:
                dlg_gone = page.evaluate("document.querySelector('[role=dialog]') ? 'open' : 'closed'")
                log(f"  - private wait[{i}] dialog={dlg_gone}")
            except Exception as e:
                log(f"  - private wait[{i}] dialog check unavailable: {e}")
                private_saved = True
                dlg_gone = 'page-changed'
                break
            if dlg_gone == 'closed':
                private_saved = True
                break
            time.sleep(1)
        if not private_saved:
            try:
                final_private_state = get_dialog_state(page)
            except Exception as e:
                final_private_state = {"skipped": True, "error": str(e)}
            fail(f"private save did not complete, state={final_private_state} url={getattr(page, 'url', 'unavailable')}")
        log(f"  - 비공개 저장 완료 (다이얼로그: {dlg_gone}, url: {getattr(page, 'url', 'unavailable')})")
    else:
        published = False
        for i in range(15):
            current_url = page.url
            if "/manage/posts" in current_url or re.search(r'https://[^/]+/entry/[^/?#]+', current_url):
                published = True
                break
            try:
                load_state = page.evaluate("document.readyState")
            except Exception:
                load_state = 'unknown'
            log(f"  - publish wait[{i}] url={current_url} readyState={load_state}")
            time.sleep(2)
        if last_dialog_message:
            log(f"  - browser dialog during publish: {last_dialog_message}")
        if not published:
            log(f"  - publish wait final state: {get_dialog_state(page)}")
            recovered_post = confirm_public_publish(page, final_title, before_posts=before_posts, timeout_s=30)
            log(f"  - post-submit publish confirmation: {recovered_post}")
            if recovered_post:
                published = True
                post_info = recovered_post
                try:
                    page.goto(POSTS_URL, wait_until="domcontentloaded", timeout=30000)
                except Exception as e:
                    log(f"  ⚠️ post-submit recovery navigation skipped: {e}")
            else:
                if last_dialog_message:
                    fail(f"browser dialog during publish and no post found: {last_dialog_message['message']}")
                fail(f"publish did not navigate to post/manage page, state={get_dialog_state(page)} url={page.url}")

    elapsed = int((time.time() - start) * 1000)
    final_url = page.url
    log(f"Step 8: 완료 — {final_url}")

    # ── Step 9: 최신 글 확인 ──
    if BLOG:
        log("Step 9: 최신 글 확인")
        if PRIVATE and "/manage/posts" in page.url:
            try:
                posts = list_recent_posts(page, navigate=False)
                log(f"  - recent posts count: {len(posts)}")
                target = None
                hint = norm_title(final_title)
                for post in posts:
                    text = norm_title(post.get('text', ''))
                    if text == hint:
                        target = post
                        break
                if not target and posts:
                    target = posts[0]
                if target:
                    m = re.search(r'/([0-9]+)$', target.get('href', ''))
                    post_info = {
                        'id': m.group(1) if m else None,
                        'url': target.get('href'),
                        'text': target.get('text', ''),
                    }
            except Exception as e:
                log(f"  ⚠️ private latest-post lookup failed: {e}")
        if not post_info:
            post_info = find_latest_post(page, final_title, before_posts=before_posts, timeout_s=60)
        log(f"  - latest post info: {post_info}")
        if not post_info or not post_info.get('url') or not post_info.get('id'):
            fail('post publish confirmation failed: postUrl/postId not found')
        post_info['publicUrl'] = public_url_for(post_info.get('url'))
        if post_info.get('publicUrl') != post_info.get('url'):
            log(f"  - public post url: {post_info['publicUrl']}")

    # ── Step 10: 발행 후 cleanup 재진입 ──
    if post_info and og_urls:
        log("Step 10: 발행 후 cleanup 재진입")
        edit_url = f"https://{BLOG}/manage/newpost/{post_info['id']}?type=post&returnURL=/manage/posts/"
        page.goto(edit_url, wait_until="domcontentloaded", timeout=30000)
        if not wait_tinymce(page, timeout_s=40):
            warning = "post_publish_edit_tinymce_timeout"
            log("  ⚠️ post-publish edit tinymce timeout")
        else:
            page.add_script_tag(path=HELPER_JS)
            time.sleep(1)
            second_cleanup = page.evaluate("typeof cleanupOGResiduals === 'function' ? cleanupOGResiduals() : null")
            log(f"  - post-publish cleanup result: {second_cleanup}")
            try:
                saved = republish_current_editor(page, PRIVATE)
                log(f"  - post-publish resave: {saved}")
                if not saved:
                    warning = "post_publish_resave_failed"
            except Exception as e:
                log(f"  ⚠️ post-publish resave raced with navigation: {e}")
                saved = False

        gap_url = post_info.get('publicUrl') or post_info['url']
        gap_check = inspect_gap(page, gap_url)
        log(f"  - gap check: {gap_check}")
        if gap_check and gap_check.get('gapPersists'):
            warning = "og_gap_persisted"

    # ── Step 11: 공개 페이지 재검증 ──
    if not PRIVATE and post_info and post_info.get('url'):
        log("Step 11: 공개 페이지 검증")
        import urllib.request
        post_url = post_info.get('publicUrl') or post_info['url']
        log(f"  - 검증 URL: {post_url}")
        try:
            req = urllib.request.Request(post_url, headers={'User-Agent':'Mozilla/5.0'})
            html = urllib.request.urlopen(req, timeout=10).read().decode('utf-8','ignore')
            m = re.search(r'<div[^>]+class="[^"]*tt_article[^"]*"[^>]*>(.*?)</div>', html, re.DOTALL)
            if not m:
                m = re.search(r'<article[^>]*>(.*?)</article>', html, re.DOTALL)
            text = re.sub('<[^>]+>', '', m.group(1) if m else '').strip() if m else ''
            vlen = len(text)
            log(f"  - 공개 페이지 본문 length: {vlen}")
            if vlen < 100:
                HARD_FAIL = "public_body_empty"
                log(f"  ❌ 본문 비어있음 ({vlen})")
            content_html = m.group(1) if m else html
            data_ke_image_count = len(re.findall(r'<figure[^>]+data-ke-type=.image.', content_html, re.IGNORECASE))
            figure_count = len(re.findall(r'<figure\b', content_html, re.IGNORECASE))
            img_count = len(re.findall(r'<img\b', content_html, re.IGNORECASE))
            expected_filenames = [os.path.basename(p) for p in image_files] if 'image_files' in locals() else []
            filename_hit_count = sum(1 for name in expected_filenames if name and name in html)
            image_count = max(data_ke_image_count, figure_count, img_count, filename_hit_count)
            log(f"  - 공개 페이지 이미지 count: effective={image_count}, data-ke={data_ke_image_count}, figure={figure_count}, img={img_count}, filenameHits={filename_hit_count}")
            if REQUIRE_PUBLIC_IMAGE_FIGURES > 0 and image_count < REQUIRE_PUBLIC_IMAGE_FIGURES:
                policy_error = f"public_image_count_{image_count}_lt_required_{REQUIRE_PUBLIC_IMAGE_FIGURES}"
                if ALLOW_MISSING_IMAGES:
                    warning = policy_error
                else:
                    HARD_FAIL = policy_error
            required_caption = os.environ.get('REQUIRE_PUBLIC_IMAGE_CAPTION', inline_image_caption).strip()
            if required_caption:
                required_caption_count = len(image_files) if image_files else REQUIRE_PUBLIC_IMAGE_FIGURES
                caption_count = len(re.findall(re.escape(required_caption), content_html))
                log(f"  - 공개 페이지 이미지 캡션 count: caption={required_caption!r}, count={caption_count}, required={required_caption_count}")
                if required_caption_count > 0 and caption_count < required_caption_count:
                    HARD_FAIL = f"public_image_caption_count_{caption_count}_lt_required_{required_caption_count}"
            if should_run_og_gate():
                log("  - public OG source/canonical/title 검증")
                public_og_gate = run_og_gate('public', post_url)
                log(f"  - OG public gate OK ({public_og_gate.get('card_count', 0)} cards)")
        except Exception as e:
            HARD_FAIL = f"public_verification_failed: {e}"
            log(f"  ❌ 검증 실패: {e}")

    result = {"success": True, "url": final_url, "elapsed_ms": elapsed, "private": PRIVATE}
    if post_info:
        result["postUrl"] = post_info.get('publicUrl') or post_info.get('url')
        result["postId"] = post_info.get('id')
        if post_info.get('url') and post_info.get('publicUrl') and post_info.get('url') != post_info.get('publicUrl'):
            result["managePostUrl"] = post_info.get('url')
    if PUBLIC_BASE_URL:
        result["publicBaseUrl"] = PUBLIC_BASE_URL
    if gap_check:
        result["gapCheck"] = gap_check
    if draft_og_gate:
        result["draftOgValidation"] = {"success": True, "count": draft_og_gate.get('count')}
    if public_og_gate:
        result["publicOgValidation"] = {"success": True, "cardCount": public_og_gate.get('card_count')}
    if warning:
        result["warning"] = warning
    if HARD_FAIL:
        result["success"] = False
        result["error"] = HARD_FAIL
        print(json.dumps(result))
        fail(HARD_FAIL)
    print(json.dumps(result))
    if result.get("postUrl"):
        print(f"TISTORY_POST_URL={result['postUrl']}", file=sys.stderr)
    browser.close()
    publish_lock.release()

PYTHON_SCRIPT
)
EXIT_CODE=$?
set -e
printf '%s\n' "$PYTHON_RESULT"
if [[ -n "$PUBLISH_TRACE_FILE" ]]; then
  mkdir -p "$(dirname "$PUBLISH_TRACE_FILE")"
  {
    echo "=== STDOUT ==="
    printf '%s\n' "$PYTHON_RESULT"
    echo "=== STDERR ==="
    cat "$TMP_STDERR"
  } > "$PUBLISH_TRACE_FILE"
fi
if [[ $EXIT_CODE -eq 0 && -n "$DIRECT_NOTIFY_CHANNEL" ]]; then
  POST_URL=$(PYTHON_RESULT_B64="$(printf '%s' "$PYTHON_RESULT" | base64)" python3 - <<'PY'
import base64, json, os
raw = base64.b64decode(os.environ.get('PYTHON_RESULT_B64', '')).decode('utf-8', 'ignore').strip().splitlines()
for line in reversed(raw):
    line = line.strip()
    if not line or not line.startswith('{'):
        continue
    try:
        obj = json.loads(line)
        print(obj.get('postUrl', ''))
        break
    except Exception:
        continue
PY
)
  if [[ -n "$POST_URL" ]]; then
    NOTIFY_WORKFLOW="$DIRECT_NOTIFY_WORKFLOW"
    if [[ -z "$NOTIFY_WORKFLOW" ]]; then
      NOTIFY_WORKFLOW="${TEMPLATE:-Tistory}"
    fi
    NOTIFY_MESSAGE="발행됨: $NOTIFY_WORKFLOW"
    NOTIFY_MESSAGE+=$'\n'"제목: $TITLE"
    NOTIFY_MESSAGE+=$'\n'"카테고리: $CATEGORY"
    if [[ -n "$DIRECT_NOTIFY_AUTHOR" ]]; then
      NOTIFY_MESSAGE+=$'\n'"작성자: $DIRECT_NOTIFY_AUTHOR"
    elif [[ -n "$DIRECT_NOTIFY_ACCOUNT" ]]; then
      NOTIFY_MESSAGE+=$'\n'"계정: $DIRECT_NOTIFY_ACCOUNT"
    fi
    if [[ -n "$BLOG" ]]; then
      NOTIFY_MESSAGE+=$'\n'"블로그: $BLOG"
    fi
    NOTIFY_MESSAGE+=$'\n'"URL: <$POST_URL>"
    echo "[direct-notify] target=$DIRECT_NOTIFY_CHANNEL workflow=$NOTIFY_WORKFLOW title=$TITLE category=$CATEGORY postUrl=$POST_URL" >&2
    set +e
    NOTIFY_ARGS=(message send --channel discord --target "$DIRECT_NOTIFY_CHANNEL" --message "$NOTIFY_MESSAGE")
    if [[ -n "$DIRECT_NOTIFY_ACCOUNT" ]]; then
      NOTIFY_ARGS+=(--account "$DIRECT_NOTIFY_ACCOUNT")
    fi
    openclaw "${NOTIFY_ARGS[@]}"
    NOTIFY_EXIT=$?
    set -e
    echo "[direct-notify] exit=$NOTIFY_EXIT" >&2
  else
    echo "[direct-notify] skipped: empty postUrl" >&2
  fi
fi
rm -f "$TMP_STDERR"
exit $EXIT_CODE
