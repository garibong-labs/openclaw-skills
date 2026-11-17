"""Opt-in MK Stage3 boundary. Stdlib only; publisher runtime supports Python 3.9.

Stage2 and Pillow run in the explicitly selected interpreter, never an engine.
All paths are supplied by the caller. Evidence is private and never reusable.
"""
import hashlib
import json
import mimetypes
import os
from pathlib import Path, PureWindowsPath
import re
import subprocess
import sys
from html.parser import HTMLParser
from html import unescape
from urllib.parse import urlsplit
import uuid


class ImagePublishError(RuntimeError):
    pass


def bounded_diagnostic(value, limit=1800):
    """Operator diagnostics only: bounded, no credential env values/assignments."""
    if isinstance(value, bytes):
        value = value.decode('utf-8', 'replace')
    text = str(value or '')
    sensitive = r'password|passwd|secret|token|credential|authorization|cookie|api[_-]?key'
    for key, secret in os.environ.items():
        if secret and re.search(sensitive, key, re.I):
            text = text.replace(secret, '[redacted]')
    text = re.sub(r'(?i)\b(?:bearer|basic)\s+[^\s,"\x27]+', '[redacted authorization]', text)
    text = re.sub(r'(?i)(\b[\w-]*(?:' + sensitive + r')[\w-]*[\s"\x27]*[:=]\s*)("[^"\n]*"|\x27[^\x27\n]*\x27|[^\s,;"\x27}]+)',
                  r'\1[redacted]', text)
    text = re.sub(r'(https?://)[^/@\s]+@', r'\1[redacted]@', text)
    text = re.sub(r'[\x00-\x08\x0b-\x1f\x7f]', '?', text)
    return text[:limit] + (' [truncated]' if len(text) > limit else '')


def article_mime(filename, content):
    # Stage1 verify() decodes JPEG only. This is a transport consistency check;
    # the mandatory Stage2 re-verification remains the decoded-image proof.
    if Path(filename).suffix.lower() not in ('.jpg', '.jpeg') or not content.startswith(b'\xff\xd8\xff'):
        raise ImagePublishError('Stage1 article requires JPEG filename and JPEG bytes')
    return 'image/jpeg'


def digest(value):
    return hashlib.sha256(value).hexdigest()


def https_src(value):
    if not isinstance(value, str) or re.search(r'[\s\x00-\x1f\x7f]|%(?![0-9a-fA-F]{2})', value):
        raise ImagePublishError('invalid attachment src')
    p = urlsplit(value)
    if p.scheme != 'https' or not p.netloc or p.username or p.password or p.fragment:
        raise ImagePublishError('absolute HTTPS attachment src required')
    return value


def guard_legacy_markers(body, template):
    class Markers(HTMLParser):
        forbidden = False

        def handle_starttag(self, tag, attrs):
            keys = dict(attrs)
            if (set(keys) & {'data-image-alt', 'data-image-caption', 'data-article-id'}
                    or any(key == 'data-image-marker' and not re.fullmatch(r'trend-image-[1-9][0-9]*', value or '')
                           for key, value in attrs)):
                self.forbidden = True
    parser = Markers()
    parser.feed(body)
    parser.close()
    # HTMLParser buffers incomplete tags and treats script/style as raw text.
    # Scan apparent start tags too, keeping quoted values and comments intact so
    # prose, escaped examples and marker names inside unrelated values are safe.
    tags = re.compile(r'''<!--.*?(?:-->|$)|<[a-zA-Z][a-zA-Z0-9:_-]*(?=[\s/>]|$)((?:[^<>"']|"[^"]*(?:"|$)|'[^']*(?:'|$))*)(?:>|(?=<)|$)''', re.S)
    attrs = re.compile(r'''\s*([^\s/=>]+)(?:\s*=\s*(?:"([^"]*)(?:"|$)|'([^']*)(?:'|$)|([^\s>]+)))?''')
    for tag in tags.finditer(body):
        if tag.group(1) is not None:
            parsed = [(a.group(1).lower(), unescape(next((v for v in a.groups()[1:] if v is not None), '')))
                      for a in attrs.finditer(tag.group(1))]
            parser.handle_starttag('', parsed)
    if parser.forbidden:
        raise ImagePublishError('image marker draft requires --mk-article-images and complete evidence')


class MKArticleImages:
    def __init__(self, *, enabled, template, private, body, current, run_dir,
                 validator, interpreter, sources, evidence_dir, banner, banner_alt,
                 selector='', legacy_images='', runner=subprocess.run):
        self.enabled = enabled
        self.runner = runner
        self.phase = 'draft'
        self.post_url = None
        self.post_id = None
        self.submitted = False
        self.ready = False
        self.rows = []
        self.banner_src = None
        self.upload_failed = False
        options = (current, run_dir, validator, interpreter, sources, evidence_dir, selector)
        if not enabled:
            if any(options):
                raise ImagePublishError('image flags require --mk-article-images')
            guard_legacy_markers(Path(body).read_text(encoding='utf-8'), template)
            return
        if not all(options[:6]) or not banner or not banner_alt:
            raise ImagePublishError('complete image flags and separate banner required')
        if template != 'mk-review' or private or legacy_images:
            raise ImagePublishError('MK images require public mk-review without legacy inline images')
        self.body = Path(body).absolute()
        self.current = Path(current).absolute()
        self.run_dir = Path(run_dir).absolute()
        self.validator = Path(validator).absolute()
        self.interpreter = Path(interpreter).absolute()
        self.sources = Path(sources).absolute()
        self.evidence = Path(evidence_dir).absolute()
        self.banner = Path(banner).absolute()
        self.banner_alt = banner_alt
        self.selector = selector
        for path in (self.body, self.current, self.validator, self.interpreter, self.sources, self.banner):
            if not path.is_file():
                raise ImagePublishError('required image input file unavailable')
        for filename in ('mk_article_images.py', 'mk_image_validation.py'):
            if not (self.validator.parent / filename).is_file():
                raise ImagePublishError('Stage2 validator siblings required')
        if self.evidence.exists() or self.evidence.is_symlink():
            raise ImagePublishError('evidence directory already exists; reconcile previous attempt before retry')
        for path in (self.run_dir, self.validator.parent):
            if path == self.evidence or path in self.evidence.parents:
                raise ImagePublishError('evidence must be outside source/validator directories')
        self.binding = self.fingerprint()
        self.draft_validation = self.gate('draft')  # MUST precede CDP, editor creation, and upload.
        state = json.loads((self.run_dir / 'manifest.json').read_text(encoding='utf-8'))
        self.plan = state['plan']
        self.assets = state['assets']
        if len(self.plan['articles']) != 4 or len(self.assets) != 4:
            raise ImagePublishError('four verified assets required')
        for entry in self.plan['articles']:
            article_mime(entry['filename'], self.article_source(entry['filename']).read_bytes())
        self.check_binding()
        if digest(self.banner.read_bytes()) in [asset['sha256'] for asset in self.assets]:
            raise ImagePublishError('banner reuses article bytes')
        self.evidence.mkdir(mode=0o700, parents=False, exist_ok=False)
        self.ready = True
        self.write('draft-gate.json', self.draft_validation)
        self.write('state.json', self.status('draft-verified'))

    def article_source(self, filename):
        if (not isinstance(filename, str) or not filename or filename in ('.', '..')
                or re.search(r'[/\\\x00]', filename) or Path(filename).is_absolute()
                or PureWindowsPath(filename).drive or Path(filename).name != filename):
            raise ImagePublishError('article filename must be a plain basename')
        source = self.run_dir / filename
        if source.is_symlink() or source.resolve().parent != self.run_dir.resolve():
            raise ImagePublishError('article source symlink escape unsupported')
        return source

    def fingerprint(self):
        state = json.loads((self.run_dir / 'manifest.json').read_text(encoding='utf-8'))
        paths = {self.body, self.current, self.sources, self.banner, self.validator,
                 Path(state['engine']['path']), Path(__file__).absolute(),
                 self.validator.parent / 'mk_article_images.py',
                 self.validator.parent / 'mk_image_validation.py'}
        # The exact source used for FilePayload must be inside this binding,
        # independently of the recursive directory enumeration.
        paths.update(self.article_source(e['filename']) for e in state['plan']['articles'])
        paths.update(p for p in self.run_dir.rglob('*') if p.is_file())
        result = {}
        for path in sorted(paths):
            if path.is_symlink():
                raise ImagePublishError('symlink evidence unsupported')
            stat = path.stat()
            result[str(path)] = (stat.st_dev, stat.st_ino, digest(path.read_bytes()))
        return result

    def check_binding(self):
        if self.fingerprint() != self.binding:
            raise ImagePublishError('source/evidence binding changed; new review required')

    def write(self, name, value):
        data = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False)
        target = self.evidence / name
        temp = self.evidence / ('.' + name + '.tmp')
        fd = os.open(str(temp), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, 'w', encoding='utf-8') as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(str(temp), str(target))
        directory_fd = os.open(str(self.evidence), os.O_RDONLY)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
        return target

    def status(self, status):
        return {'schema_version': 1, 'status': status, 'phase': self.phase,
                'submitted': self.submitted, 'postUrl': self.post_url, 'postId': self.post_id,
                'automaticRetryAllowed': False}

    def failure(self, error=None):
        result = {'success': False, 'error': 'mk-images/' + self.phase + '-failed',
                  'detail': bounded_diagnostic(error, 500),
                  **self.status('failed')}
        if self.ready:
            try:
                self.write('state.json', result)
            except OSError:
                pass  # Still emit the non-success publication identity on disk failure.
        return result

    def invoke(self, command, record=None):
        env = dict(os.environ, PYTHONDONTWRITEBYTECODE='1')
        try:
            proc = self.runner(command, text=True, capture_output=True, timeout=90, env=env)
        except subprocess.TimeoutExpired as error:
            raise ImagePublishError('validator timeout: stdout=' + bounded_diagnostic(error.stdout, 600)
                                    + '; stderr=' + bounded_diagnostic(error.stderr, 600)) from None
        diagnostics = ('; stdout=' + bounded_diagnostic(proc.stdout, 600)
                       + '; stderr=' + bounded_diagnostic(proc.stderr, 600))
        if len(proc.stdout or '') > 131072:
            raise ImagePublishError('oversized validator output' + diagnostics)
        try:
            result = json.loads(proc.stdout)
        except (ValueError, TypeError):
            raise ImagePublishError('validator did not return structured success' + diagnostics)
        if not isinstance(result, dict):
            raise ImagePublishError('validator object required' + diagnostics)
        if self.ready:
            self.write(record or self.phase + '-gate.json', result)
        if proc.returncode != 0 or result.get('success') is not True:
            # Stage2 puts errors after potentially long per-article evidence.
            # Keep the rejection reason visible even when stdout is truncated.
            reason = bounded_diagnostic(json.dumps(result.get('errors', result.get('error', '')), ensure_ascii=False), 400)
            raise ImagePublishError('mandatory image validator rejected ' + self.phase + '; errors=' + reason + diagnostics)
        return result

    def gate(self, phase, snapshot=None, post_url=None):
        self.phase = phase
        self.check_binding()
        command = [str(self.interpreter), str(self.validator), phase,
                   '--body-file', str(self.body), '--image-input', str(self.current),
                   '--image-run-dir', str(self.run_dir), '--source-evidence-file', str(self.sources)]
        if phase != 'draft':
            command += ['--snapshot-file', str(snapshot), '--upload-receipt', str(self.evidence / 'upload-receipt.json')]
            if self.selector and phase == 'public':
                command += ['--content-selector', self.selector]
        if post_url:
            command += ['--post-url', post_url]
        result = self.invoke(command)
        if result.get('mode') != phase or (result.get('images') or {}).get('verified') != 4:
            raise ImagePublishError('Stage2 four-image proof required')
        self.check_binding()
        return result

    def upload_one(self, page, upload, payload, entry=None):
        if self.upload_failed:
            raise ImagePublishError('upload previously failed; no second file delivery')
        token = uuid.uuid4().hex
        try:
            page.evaluate('(token) => beginMKImageUpload(token)', token)
            # FilePayload freezes exactly the bytes whose digest was checked, even if
            # the on-disk pathname is replaced while Playwright transfers the file.
            upload(page, payload, 'MK article' if entry else 'MK banner', single_delivery=True)
            page.wait_for_function('(token) => pollMKImageUpload(token).ready',
                                   arg=token, timeout=30000, polling=250)
            result = page.evaluate('(args) => finishMKImageUpload(args)',
                                   {'token': token, 'entry': entry, 'bannerAlt': self.banner_alt})
            if not isinstance(result, dict) or result.get('success') is not True or result.get('token') != token:
                raise ImagePublishError('upload-operation attachment identity unavailable')
            return https_src(result.get('src'))
        except Exception:
            self.upload_failed = True
            try:
                page.evaluate('(token) => abortMKImageUpload(token)', token)
            except Exception:
                pass  # Cleanup cannot replace the original cause or permit redelivery.
            raise

    def upload_articles(self, page, upload):
        self.phase = 'upload'
        if self.rows:
            raise ImagePublishError('article uploads already started')
        for entry, asset in zip(self.plan['articles'], self.assets):
            self.check_binding()
            content = self.article_source(entry['filename']).read_bytes()
            if digest(content) != asset['sha256']:
                raise ImagePublishError('article source SHA changed')
            src = self.upload_one(page, upload, {'name': entry['filename'], 'mimeType': article_mime(entry['filename'], content), 'buffer': content}, entry)
            self.check_binding()
            if src in [row['uploaded_src'] for row in self.rows]:
                raise ImagePublishError('duplicate upload attachment')
            self.rows.append({**{k: entry[k] for k in ('index', 'article_id', 'source_url', 'marker', 'filename')},
                              'file_sha256': digest(content), 'uploaded_src': src})
            self.write('upload-receipt.json', {'schema_version': 1, 'input_sha256': self.plan['input_sha256'], 'articles': self.rows})

    def upload_banner(self, page, upload):
        self.phase = 'banner'
        if len(self.rows) != 4 or self.banner_src:
            raise ImagePublishError('banner requires four completed article uploads')
        self.check_binding()
        content = self.banner.read_bytes()
        if digest(content) != self.binding[str(self.banner)][2]:
            raise ImagePublishError('banner source SHA changed')
        if digest(content) in [a['sha256'] for a in self.assets]:
            raise ImagePublishError('banner reuses article bytes')
        self.banner_src = self.upload_one(page, upload, {'name': self.banner.name, 'mimeType': mimetypes.guess_type(self.banner.name)[0] or 'application/octet-stream', 'buffer': content})
        if self.banner_src in [row['uploaded_src'] for row in self.rows]:
            raise ImagePublishError('banner reuses article attachment')
        self.check_binding()
        self.write('banner.json', {'src': self.banner_src, 'alt': self.banner_alt})

    def check_upload_evidence(self):
        receipt = json.loads((self.evidence / 'upload-receipt.json').read_text(encoding='utf-8'))
        expected = {'schema_version': 1, 'input_sha256': self.plan['input_sha256'], 'articles': self.rows}
        banner = json.loads((self.evidence / 'banner.json').read_text(encoding='utf-8'))
        if len(self.rows) != 4 or receipt != expected or banner != {'src': self.banner_src, 'alt': self.banner_alt}:
            raise ImagePublishError('operation receipt/banner evidence changed')

    def snapshot_gate(self, phase, html, post_url=None):
        self.phase = phase
        if not isinstance(html, str) or not html or len(html.encode('utf-8')) > 10 * 1024 * 1024:
            raise ImagePublishError('bounded nonempty snapshot required')
        self.check_upload_evidence()
        snapshot = self.write(phase + '.html', html)
        snapshot_sha = digest(snapshot.read_bytes())
        result = self.gate(phase, snapshot, post_url)
        # Use Stage2's exact scoped parser/URL identity in its own interpreter.
        command = [str(self.interpreter), str(Path(__file__).absolute()), '--audit-banner',
                   str(self.validator.parent), str(snapshot), str(self.evidence / 'banner.json'),
                   self.selector if phase == 'public' else '']
        self.invoke(command, phase + '-banner-audit.json')
        self.check_binding()
        self.check_upload_evidence()
        if digest(snapshot.read_bytes()) != snapshot_sha:
            raise ImagePublishError('snapshot changed during validation')
        return result

    def editor_gate(self, page):
        self.phase = 'editor'
        try:
            normalized = page.evaluate('() => normalizeMKEmptyParagraphs()')
        except Exception as error:
            raise ImagePublishError('MK empty paragraph normalization unavailable') from error
        if not isinstance(normalized, dict) or normalized.get('success') is not True:
            raise ImagePublishError('MK empty paragraph normalization unsuccessful')
        observed = page.evaluate('() => preserveMKOGThumbnailEvidence()')
        if not isinstance(observed, dict) or observed.get('success') is not True:
            raise ImagePublishError('observed OG thumbnail evidence unavailable')
        try:
            html = page.evaluate('''() => {
                const editor = typeof tinymce !== 'undefined' && tinymce.activeEditor;
                if (!editor || typeof editor.save !== 'function' || typeof editor.getBody !== 'function') return null;
                editor.save();
                const body = editor.getBody();
                if (!body || body.nodeType !== 1) return null;
                const html = body.innerHTML;
                return typeof html === 'string' && html.trim() ? html : null;
            }''')
        except Exception as error:
            raise ImagePublishError('MK editor body snapshot unavailable') from error
        return self.snapshot_gate('editor', html)

    def before_submit(self, page):
        if self.submitted:
            raise ImagePublishError('submission already started; no automatic retry')
        self.editor_gate(page)
        self.phase = 'submit'
        self.check_binding()
        self.submitted = True
        self.write('state.json', self.status('submission-started'))

    def confirm_publication(self, post_url, post_id):
        confirmed_url = https_src(post_url)
        confirmed_id = str(post_id or '')
        if not confirmed_id:
            raise ImagePublishError('publication identity missing')
        self.post_url, self.post_id = confirmed_url, confirmed_id
        self.write('state.json', self.status('published-awaiting-verification'))

    def public_gate(self, fetch):
        self.phase = 'public'
        self.check_binding()
        if not self.post_url or not self.submitted:
            raise ImagePublishError('confirmed publication required before public fetch')
        result = self.snapshot_gate('public', fetch(self.post_url), self.post_url)
        self.write('state.json', self.status('verified'))
        return result


def audit_banner(directory, snapshot, banner_file, selector):
    # Read-only Stage2 helper import. Never import/execute the generation engine.
    sys.path.insert(0, directory)
    try:
        import mk_image_validation as images
    except Exception:
        raise ImagePublishError('audit/import-failed') from None
    if not all(callable(getattr(images, name, None)) for name in
               ('content_root', 'attachment_identity', 'require_visible', 'compact')):
        raise ImagePublishError('audit/dependency-api')
    try:
        html = Path(snapshot).read_text(encoding='utf-8')
        banner = json.loads(Path(banner_file).read_text(encoding='utf-8'))
        if not isinstance(banner, dict) or not all(isinstance(banner.get(k), str) and banner[k] for k in ('src', 'alt')):
            raise ValueError('banner input required')
    except (OSError, UnicodeError, ValueError):
        raise ImagePublishError('audit/input-invalid') from None
    try:
        root = images.content_root(html, selector or None)
    except (AttributeError, TypeError):
        raise ImagePublishError('audit/dependency-api') from None
    except Exception:
        raise ImagePublishError('audit/input-invalid') from None
    try:
        nodes = list(root.walk())
        first = next((i for i, n in enumerate(nodes) if n.tag == 'h2' and images.compact(n.text()) != '들어가며'), None)
        if first is None:
            raise ImagePublishError('audit/input-invalid')
        identity = images.attachment_identity(banner['src'])
        before = [n for n in nodes[:first] if n.tag == 'img']
        if len(before) != 1 or images.attachment_identity(before[0].attrs.get('src', '')) != identity or before[0].attrs.get('alt') != banner['alt']:
            raise ImagePublishError('audit/banner-mismatch')
        images.require_visible(before[0])
        figure = before[0].parent
        while figure is not None and figure.tag != 'figure':
            figure = figure.parent
        if figure is None or figure.attrs.get('data-ke-type') != 'image':
            raise ImagePublishError('audit/banner-mismatch')
        if any(n.tag in ('iframe', 'embed', 'object', 'video', 'audio', 'svg', 'canvas') for n in nodes):
            raise ImagePublishError('audit/embed-mismatch')
    except (AttributeError, TypeError):
        raise ImagePublishError('audit/dependency-api') from None
    except ValueError:
        raise ImagePublishError('audit/banner-mismatch') from None
    return {'success': True}


if __name__ == '__main__':
    try:
        if len(sys.argv) != 6 or sys.argv[1] != '--audit-banner':
            raise ImagePublishError('audit/input-invalid')
        print(json.dumps(audit_banner(*sys.argv[2:])))
    except ImagePublishError as error:
        print(json.dumps({'success': False, 'error': str(error)}))
        sys.exit(1)
    except Exception:
        print(json.dumps({'success': False, 'error': 'audit/internal-failed'}))
        sys.exit(1)
