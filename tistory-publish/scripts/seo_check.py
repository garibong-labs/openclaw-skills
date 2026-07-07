#!/usr/bin/env python3
"""seo_check.py — 발행 전 SEO 정적 검사 (Tistory 본문 HTML 기준)

발행 파이프라인(publish-post.sh --seo-check strict|warn)에서 호출되거나
단독으로 실행할 수 있다. 표준 라이브러리만 사용한다.

Usage:
    python3 seo_check.py --title "글 제목" --body-file body.html \
        [--tags "태그1,태그2"] [--keyword "핵심키워드"] [--blog my.tistory.com] \
        [--mode strict|warn] [--min-body-chars 1000]

출력: stdout에 JSON 한 줄 {"success", "errors", "warnings", "stats"}
      stderr에 사람이 읽는 리포트
종료코드: strict 모드에서 error가 있으면 1, 그 외 0
"""

import argparse
import json
import re
import sys
from html.parser import HTMLParser


class BodyParser(HTMLParser):
    """본문 HTML에서 SEO 검사에 필요한 구조를 추출한다."""

    HEADING_TAGS = {"h1", "h2", "h3", "h4"}

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.headings = []        # [(tag, text)]
        self.images = []          # [{"src", "alt"}]
        self.links = []           # [href]
        self.og_placeholders = [] # [url]
        self.text_parts = []      # 본문 노출 텍스트
        self.lead_parts = []      # 첫 heading 이전 텍스트 (메타 디스크립션 소스)
        self._seen_heading = False
        self._current_heading = None
        self._heading_text = []

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag in self.HEADING_TAGS:
            self._seen_heading = True
            self._current_heading = tag
            self._heading_text = []
        elif tag == "img":
            self.images.append({"src": attrs.get("src", ""), "alt": attrs.get("alt")})
        elif tag == "a" and attrs.get("href"):
            self.links.append(attrs["href"])
        if attrs.get("data-og-placeholder"):
            self.og_placeholders.append(attrs["data-og-placeholder"])

    def handle_endtag(self, tag):
        if tag in self.HEADING_TAGS and self._current_heading == tag:
            self.headings.append((tag, "".join(self._heading_text).strip()))
            self._current_heading = None

    def handle_data(self, data):
        if self._current_heading:
            self._heading_text.append(data)
        else:
            self.text_parts.append(data)
            if not self._seen_heading:
                self.lead_parts.append(data)

    @staticmethod
    def _clean(parts):
        return re.sub(r"\s+", " ", "".join(parts)).replace("​", "").strip()

    @property
    def body_text(self):
        return self._clean(self.text_parts)

    @property
    def lead_text(self):
        return self._clean(self.lead_parts)


def check(title, body_html, tags, keyword, blog, min_body_chars):
    errors, warnings = [], []
    parser = BodyParser()
    parser.feed(body_html)

    body_text = parser.body_text
    lead_text = parser.lead_text
    heading_text = " ".join(t for _, t in parser.headings)

    # ── 제목 ──
    if not title.strip():
        errors.append("E-TITLE-EMPTY: 제목이 비어 있음")
    elif len(title) > 100:
        errors.append(f"E-TITLE-LONG: 제목 {len(title)}자 — 100자 초과")
    elif len(title) > 60:
        warnings.append(f"W-TITLE-LONG: 제목 {len(title)}자 — 검색 결과에서 잘릴 수 있음 (한글 기준 30~35자 노출, 핵심 키워드를 앞쪽에)")

    if keyword:
        if keyword.lower() not in title.lower():
            warnings.append(f"W-TITLE-KEYWORD: 제목에 핵심 키워드 '{keyword}' 없음")
        elif title.lower().find(keyword.lower()) > 20:
            warnings.append(f"W-TITLE-KEYWORD-POS: 핵심 키워드 '{keyword}'가 제목 뒤쪽에 있음 — 앞쪽 배치 권장")

    # ── 도입부 (메타 디스크립션 소스) ──
    # Tistory는 본문 시작부를 meta description / og:description으로 사용한다.
    if len(lead_text) < 30:
        errors.append(f"E-LEAD-MISSING: 첫 h2 이전 도입부 문단이 없거나 너무 짧음 ({len(lead_text)}자) — 검색 결과 요약문이 비게 됨. 첫 문단에 80~150자 요약을 넣을 것")
    elif len(lead_text) < 80:
        warnings.append(f"W-LEAD-SHORT: 도입부 {len(lead_text)}자 — 80~150자 권장 (메타 디스크립션으로 노출됨)")
    if keyword and keyword.lower() not in body_text[:150].lower():
        warnings.append(f"W-LEAD-KEYWORD: 본문 첫 150자 안에 핵심 키워드 '{keyword}' 없음")

    # ── 헤딩 구조 ──
    h2s = [t for tag, t in parser.headings if tag == "h2"]
    if len(h2s) < 2:
        warnings.append(f"W-H2-FEW: h2 소제목 {len(h2s)}개 — 2개 이상으로 스캔 가능한 구조 권장")
    first_heading = parser.headings[0][0] if parser.headings else None
    if first_heading and first_heading not in ("h2", "h1"):
        warnings.append(f"W-HEADING-ORDER: 첫 헤딩이 {first_heading} — h2부터 시작하는 계층 권장")
    if keyword and parser.headings and keyword.lower() not in heading_text.lower():
        warnings.append(f"W-HEADING-KEYWORD: 어떤 소제목에도 핵심 키워드 '{keyword}' 없음 — 최소 1개 h2/h3에 포함 권장")

    # ── 이미지 alt ──
    for i, img in enumerate(parser.images):
        if not (img["alt"] or "").strip():
            errors.append(f"E-IMG-ALT: {i + 1}번째 이미지에 alt 텍스트 없음 (src: {img['src'][:60]}) — 이미지 검색 유입과 접근성에 필수")

    # ── 링크 ──
    internal = [h for h in parser.links if blog and blog in h]
    external = [h for h in parser.links if h.startswith("http") and (not blog or blog not in h)]
    if blog and not internal:
        warnings.append("W-NO-INTERNAL-LINK: 같은 블로그로 가는 내부 링크 0개 — 이전 글 2~3개 링크 권장 (크롤링·체류시간에 유리)")
    if not external and not parser.og_placeholders:
        warnings.append("W-NO-OUTBOUND: 외부 출처 링크/OG 카드가 없음 — 원문 출처 링크 권장")

    # ── 본문 분량 ──
    if len(body_text) < min_body_chars:
        warnings.append(f"W-BODY-SHORT: 본문 노출 텍스트 {len(body_text)}자 — {min_body_chars}자 이상 권장 (단순 발췌 수준은 검색 노출 불리)")

    # ── 태그 ──
    if tags:
        normalized = [t.strip() for t in tags if t.strip()]
        lowered = [t.lower() for t in normalized]
        dupes = sorted({t for t in lowered if lowered.count(t) > 1})
        if dupes:
            errors.append(f"E-TAG-DUP: 중복 태그 {dupes}")
        if len(normalized) < 3:
            warnings.append(f"W-TAGS-FEW: 태그 {len(normalized)}개 — 5~10개 권장 (범용 + 롱테일 혼합)")
        elif len(normalized) > 10:
            warnings.append(f"W-TAGS-MANY: 태그 {len(normalized)}개 — 10개 이하 권장 (과다 태그는 희석됨)")

    stats = {
        "title_chars": len(title),
        "lead_chars": len(lead_text),
        "body_chars": len(body_text),
        "h2_count": len(h2s),
        "h3_count": len([1 for tag, _ in parser.headings if tag == "h3"]),
        "image_count": len(parser.images),
        "internal_links": len(internal),
        "external_links": len(external),
        "og_placeholders": len(parser.og_placeholders),
        "tag_count": len([t for t in tags if t.strip()]) if tags else 0,
    }
    return errors, warnings, stats


def main():
    ap = argparse.ArgumentParser(description="Tistory 발행 전 SEO 검사")
    ap.add_argument("--title", required=True)
    ap.add_argument("--body-file", required=True)
    ap.add_argument("--tags", default="", help="쉼표 구분 태그 목록")
    ap.add_argument("--keyword", default="", help="핵심 키워드 (생략 시 제목 첫 단어)")
    ap.add_argument("--blog", default="", help="블로그 도메인 (내부 링크 검사용)")
    ap.add_argument("--mode", choices=["strict", "warn"], default="strict")
    ap.add_argument("--min-body-chars", type=int, default=1000)
    args = ap.parse_args()

    try:
        with open(args.body_file, encoding="utf-8") as f:
            body_html = f.read()
    except OSError as e:
        print(json.dumps({"success": False, "errors": [f"E-BODY-FILE: {e}"], "warnings": [], "stats": {}}, ensure_ascii=False))
        sys.exit(1)

    keyword = args.keyword.strip() or (args.title.split()[0] if args.title.split() else "")
    tags = args.tags.split(",") if args.tags else []

    errors, warnings, stats = check(args.title, body_html, tags, keyword, args.blog.strip(), args.min_body_chars)

    for line in errors:
        print(f"  ❌ {line}", file=sys.stderr)
    for line in warnings:
        print(f"  ⚠️  {line}", file=sys.stderr)
    if not errors and not warnings:
        print("  ✅ SEO 검사 통과", file=sys.stderr)
    print(f"  ℹ️  stats: {json.dumps(stats, ensure_ascii=False)}", file=sys.stderr)

    success = not errors
    print(json.dumps({"success": success, "mode": args.mode, "keyword": keyword,
                      "errors": errors, "warnings": warnings, "stats": stats}, ensure_ascii=False))
    sys.exit(1 if (errors and args.mode == "strict") else 0)


if __name__ == "__main__":
    main()
