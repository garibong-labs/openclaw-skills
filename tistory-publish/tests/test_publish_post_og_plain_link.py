"""Behavior tests for the daum-trends plain-link fallback (2026-09-29 abort).

Preserved incident: both original OG attempts on the same encoded Wikipedia
source URL were confirmed HTTP 500 + scrap payload code 40009, the placeholder
carried no data-og-fallback-urls candidates, and the publisher failed the whole
post closed. Under the bounded contract, that exact replay may now degrade the
source attribution to an explicit ordinary hyperlink — only when the caller
(daum-trends without a strict custom OG validator) opted in, the source URL is
a conservative safe external http(s) URL, and no eligible Daum candidate
exists. Everything else keeps the existing fail-closed behavior.

Reuses the ast-extraction fakes from test_publish_post_og_retry; no network,
no browser.
"""
import ipaddress
import json
import re
import unittest
from pathlib import Path

import test_publish_post_og_retry as base


SCRIPT_PATH = base.SCRIPT_PATH
FIXTURE_PATH = Path(__file__).resolve().parent / "fixtures" / "daum-trends-2026-09-29-og-500-40009-incident.json"
FUNCTION_NAMES = base.FUNCTION_NAMES | {
    "safe_plain_link_source_url",
    # Shared plain-link degrade policy (40009 no-candidate + exhausted-pair
    # 40002) lives in these helpers; the render flow calls them at runtime.
    "degrade_to_plain_link",
    "exhausted_pair_confirmed_500_40002",
}

WIKI_URL = "https://ko.wikipedia.org/wiki/%EC%9E%A5%ED%95%9C%EB%B3%84"
DAUM_PRIMARY = base.DAUM_PRIMARY
DAUM_NEXT = base.DAUM_NEXT
MOBILE_DC = base.MOBILE_URL_2026_08_13
DESKTOP_DC = base.DESKTOP_URL_2026_08_13


def load_functions(overrides):
    original = base.FUNCTION_NAMES
    base.FUNCTION_NAMES = FUNCTION_NAMES
    try:
        return base.load_og_functions({"ipaddress": ipaddress, **overrides})
    finally:
        base.FUNCTION_NAMES = original


def scrap_40009(url):
    return base.scrap_response(url, 500, '{"code": 40009}')


class PlainLinkPage(base.FakePage):
    """FakePage plus the plain-link helper surface: conversion, verification,
    and a fully scriptable cleanup result (including plainLinks)."""

    def __init__(self, attempts, convert_result=None, verify_result=None,
                 cleanup_result=None, **kwargs):
        super().__init__(attempts, **kwargs)
        self.convert_calls = []
        self.verify_calls = []
        self.convert_result = convert_result
        self.verify_result = verify_result
        self.cleanup_result = cleanup_result

    def evaluate(self, script, arg=None):
        if script.startswith("typeof prepareOGPlaceholder"):
            return super().evaluate(script, arg)
        if "convertPendingToPlainLink" in script:
            self.convert_calls.append(arg)
            if self.convert_result is not None:
                return dict(self.convert_result)
            return {"success": True, "url": arg, "href": arg, "marker": "data-og-plain-link", "duplicatesRemoved": 0}
        if "verifyOGPlainLink" in script:
            self.verify_calls.append(arg)
            if self.verify_result is not None:
                return dict(self.verify_result)
            return {"found": True, "markerCount": 1, "href": arg, "target": "_blank", "rel": "noopener noreferrer"}
        if "cleanupOGResiduals" in script and self.cleanup_result is not None:
            return dict(self.cleanup_result)
        return super().evaluate(script, arg)


class PlainLinkFallbackTests(unittest.TestCase):
    def make_namespace(self, env=None):
        logs = []
        fake_time = base.FakeTime()

        def fail(message):
            raise base.PublishAbort(message)

        namespace = load_functions(
            {
                "time": fake_time,
                "log": logs.append,
                "fail": fail,
                "os": base.FakeOS(env or {}),
                "HELPER_JS": "/fake/helper.js",
            }
        )
        return namespace, fake_time, logs

    def render(self, ns, page, url, phase="step5", fallback_urls=None, allow=False):
        return ns["render_og_card_with_fallback"](
            page, url, 1, phase, fallback_urls, allow_plain_link_fallback=allow
        )

    def load_fixture(self):
        return json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))

    def fixture_page(self, fixture, **kwargs):
        attempts = [
            {
                "responses": [
                    base.scrap_response(
                        record["url"],
                        record["scrapStatus"],
                        json.dumps({"code": int(record["scrapCode"])}),
                    )
                ],
                "status": {"found": record["found"], "ogCardCount": record["ogCardCount"]},
            }
            for record in fixture["attempts"]
        ]
        return PlainLinkPage(attempts, **kwargs)

    # ── conservative safe external source URL contract ──────────────────────

    def test_safe_source_url_accepts_conservative_external_urls(self):
        ns, _, _ = self.make_namespace()
        safe = ns["safe_plain_link_source_url"]
        self.assertEqual(safe(WIKI_URL), WIKI_URL)
        self.assertEqual(safe(f"  {WIKI_URL}  "), WIKI_URL)
        self.assertEqual(safe("http://example.com/a?b=c"), "http://example.com/a?b=c")
        self.assertEqual(safe("https://example.com:8443/path"), "https://example.com:8443/path")
        self.assertEqual(safe("https://8.8.8.8/status"), "https://8.8.8.8/status")

    def test_safe_source_url_rejects_unsafe_or_malformed_urls(self):
        ns, _, _ = self.make_namespace()
        safe = ns["safe_plain_link_source_url"]
        for url in [
            None,
            "",
            "   ",
            12345,
            "not a url",
            "ftp://example.com/a",
            "javascript:alert(1)",
            "file:///etc/passwd",
            "//example.com/protocol-relative",
            "https://",
            "https:///path-only",
            "https://user@example.com/",
            "https://user:pass@example.com/",
            "http://localhost/x",
            "http://LOCALHOST:8080/x",
            "http://foo.localhost/x",
            "http://printer.local/x",
            "http://intranet/x",
            "http://127.0.0.1/x",
            "http://10.0.0.5/x",
            "http://192.168.1.2/x",
            "http://172.16.0.1/x",
            "http://169.254.1.1/x",
            "http://100.64.0.1/x",
            "http://0.0.0.0/x",
            "http://255.255.255.255/x",
            "http://224.0.0.1/x",
            "http://192.0.2.10/x",
            "http://[::1]/x",
            "http://[fe80::1]/x",
            "http://[fc00::1]/x",
        ]:
            with self.subTest(url=url):
                self.assertIsNone(safe(url))

    # ── exact incident replay (preserved 161513 payload, repo fixture) ──────

    def test_fixture_is_repo_contained_and_matches_incident_shape(self):
        raw = FIXTURE_PATH.read_text(encoding="utf-8")
        fixture = json.loads(raw)
        for leak in ["/Users/", "workspace-ruth", "/tmp/", "runtime.html"]:
            self.assertNotIn(leak, raw)
        self.assertEqual(fixture["template"], "daum-trends")
        self.assertEqual(fixture["url"], WIKI_URL)
        self.assertEqual(fixture["fallbackUrls"], [])
        self.assertEqual(
            [record["kind"] for record in fixture["attempts"]],
            ["original", "original-retry"],
        )
        for record in fixture["attempts"]:
            self.assertEqual(record["url"], WIKI_URL)
            self.assertFalse(record["found"])
            self.assertTrue(record["scrapObserved"])
            self.assertEqual(record["scrapStatus"], 500)
            self.assertEqual(record["scrapCode"], "40009")

    def test_incident_replay_downgrades_to_plain_link_under_contract(self):
        ns, fake_time, logs = self.make_namespace()
        fixture = self.load_fixture()
        page = self.fixture_page(fixture)
        result = self.render(
            ns, page, fixture["url"],
            fallback_urls=fixture["fallbackUrls"], allow=True,
        )
        self.assertEqual(
            result,
            {
                "plainLinkFallback": True,
                "url": WIKI_URL,
                "reason": "confirmed scrap 500/code=40009 twice, no eligible Daum candidate",
                "phase": "step5",
            },
        )
        # Attribution preserved: the exact encoded URL, never a substitute.
        self.assertEqual(page.convert_calls, [WIKI_URL])
        self.assertEqual(page.verify_calls, [WIKI_URL])
        # No third Enter press: the downgrade is not another card attempt.
        self.assertEqual(page.enter_presses, 2)
        # The 40009 degrade passes no pending_url, so there is no extra
        # prepareOGRetry rebind (the pending paragraph is still keyed to the
        # original URL) and no added delay: exactly the two attempt preps and
        # the pre-existing pacing.
        self.assertEqual(
            page.prepare_calls,
            [("placeholder", WIKI_URL), ("retry", {"fromUrl": WIKI_URL, "toUrl": WIKI_URL})],
        )
        self.assertEqual(fake_time.sleeps, [0.5] + [1.5] * 8 + [2.0, 0.5] + [1.5] * 8)
        self.assertTrue(
            any("confirmed 500/code=40009 -> degraded to plain source link" in line and WIKI_URL in line and "phase=step5" in line for line in logs)
        )

    def test_incident_replay_without_opt_in_keeps_fail_closed_abort(self):
        ns, _, _ = self.make_namespace()
        fixture = self.load_fixture()
        page = self.fixture_page(fixture)
        with self.assertRaisesRegex(base.PublishAbort, "OG card render failed before publish"):
            self.render(ns, page, fixture["url"], fallback_urls=fixture["fallbackUrls"])
        self.assertEqual(page.convert_calls, [])
        self.assertEqual(page.enter_presses, 2)

    def test_recovery_phase_replay_uses_same_path_and_reports_phase(self):
        ns, _, logs = self.make_namespace()
        fixture = self.load_fixture()
        page = self.fixture_page(fixture)
        result = self.render(
            ns, page, fixture["url"],
            phase="recovery", fallback_urls=fixture["fallbackUrls"], allow=True,
        )
        self.assertEqual(result["phase"], "recovery")
        self.assertTrue(any("phase=recovery" in line and "degraded to plain source link" in line for line in logs))

    # ── every excluded path stays fail-closed / unchanged ───────────────────

    def test_eligible_daum_candidate_still_tried_once_and_wins(self):
        ns, _, _ = self.make_namespace()
        page = PlainLinkPage([
            {"responses": [scrap_40009(DAUM_PRIMARY)], "status": base.not_found_status()},
            {"responses": [scrap_40009(DAUM_PRIMARY)], "status": base.not_found_status()},
            {"responses": [base.scrap_response(DAUM_NEXT, 200, '{"code": 0}')], "status": base.found_status()},
        ])
        result = self.render(ns, page, DAUM_PRIMARY, fallback_urls=[DAUM_NEXT], allow=True)
        self.assertEqual(result, DAUM_NEXT)
        self.assertEqual(page.convert_calls, [])
        self.assertEqual(page.enter_presses, 3)

    def test_eligible_candidate_failure_fails_closed_without_downgrade(self):
        ns, _, _ = self.make_namespace()
        page = PlainLinkPage([
            {"responses": [scrap_40009(DAUM_PRIMARY)], "status": base.not_found_status()},
            {"responses": [scrap_40009(DAUM_PRIMARY)], "status": base.not_found_status()},
            {"responses": [scrap_40009(DAUM_NEXT)], "status": base.not_found_status()},
        ])
        with self.assertRaisesRegex(base.PublishAbort, "OG card render failed before publish"):
            self.render(ns, page, DAUM_PRIMARY, fallback_urls=[DAUM_NEXT], allow=True)
        self.assertEqual(page.convert_calls, [])
        self.assertEqual(page.enter_presses, 3)

    def test_unconfirmed_results_never_downgrade_even_with_opt_in(self):
        cases = {
            "generic found=false without scrap": [],
            "status 500 without parsable code": [base.scrap_response(WIKI_URL, 500, "<html>error</html>")],
            "code 40009 without status 500": [base.scrap_response(WIKI_URL, 200, '{"code": 40009}')],
            "non-40009 code": [base.scrap_response(WIKI_URL, 500, '{"code": 40008}')],
            "40002 code": [base.scrap_response(WIKI_URL, 500, '{"code": 40002}')],
        }
        for label, responses in cases.items():
            with self.subTest(case=label):
                ns, _, _ = self.make_namespace()
                page = PlainLinkPage([
                    {"responses": list(responses), "status": base.not_found_status()},
                    {"responses": list(responses), "status": base.not_found_status()},
                ])
                with self.assertRaisesRegex(base.PublishAbort, "OG card render failed before publish"):
                    self.render(ns, page, WIKI_URL, fallback_urls=[], allow=True)
                self.assertEqual(page.convert_calls, [], label)
                self.assertEqual(page.enter_presses, 2, label)

    def test_one_confirmed_plus_one_unknown_never_downgrades(self):
        second_cases = {
            "second unobserved": [],
            "second unparsable": [base.scrap_response(WIKI_URL, 500, "<html>error</html>")],
            "second wrong status": [base.scrap_response(WIKI_URL, 200, '{"code": 40009}')],
        }
        for label, second in second_cases.items():
            with self.subTest(case=label):
                ns, _, _ = self.make_namespace()
                page = PlainLinkPage([
                    {"responses": [scrap_40009(WIKI_URL)], "status": base.not_found_status()},
                    {"responses": list(second), "status": base.not_found_status()},
                ])
                with self.assertRaisesRegex(base.PublishAbort, "OG card render failed before publish"):
                    self.render(ns, page, WIKI_URL, fallback_urls=[], allow=True)
                self.assertEqual(page.convert_calls, [], label)

    def test_unsafe_source_urls_never_downgrade_even_when_confirmed(self):
        for url in [
            "http://localhost/incident",
            "http://10.0.0.5/incident",
            "http://[::1]/incident",
            "https://user:pass@example.com/incident",
            "http://intranet/incident",
        ]:
            with self.subTest(url=url):
                ns, _, logs = self.make_namespace()
                page = PlainLinkPage([
                    {"responses": [scrap_40009(url)], "status": base.not_found_status()},
                    {"responses": [scrap_40009(url)], "status": base.not_found_status()},
                ])
                with self.assertRaisesRegex(base.PublishAbort, "OG card render failed before publish"):
                    self.render(ns, page, url, fallback_urls=[], allow=True)
                self.assertEqual(page.convert_calls, [])
                self.assertTrue(any("failing closed" in line for line in logs))

    def test_confirmed_40002_dcinside_pair_fallback_unchanged_with_opt_in(self):
        ns, _, _ = self.make_namespace()
        page = PlainLinkPage([
            {"responses": [base.scrap_response(MOBILE_DC)], "status": base.not_found_status()},
            {"responses": [base.scrap_response(MOBILE_DC)], "status": base.not_found_status()},
            {"responses": [], "status": base.found_status()},
        ])
        result = self.render(ns, page, MOBILE_DC, fallback_urls=[], allow=True)
        self.assertEqual(result, DESKTOP_DC)
        self.assertEqual(page.convert_calls, [])

    def test_first_and_second_attempt_card_success_unchanged_with_opt_in(self):
        ns, _, _ = self.make_namespace()
        page = PlainLinkPage([
            {"responses": [base.scrap_response(WIKI_URL, 200, '{"code": 0}')], "status": base.found_status()},
        ])
        self.assertEqual(self.render(ns, page, WIKI_URL, allow=True), WIKI_URL)
        self.assertEqual(page.convert_calls, [])

        page = PlainLinkPage([
            {"responses": [scrap_40009(WIKI_URL)], "status": base.not_found_status()},
            {"responses": [], "status": base.found_status()},
        ])
        self.assertEqual(self.render(ns, page, WIKI_URL, allow=True), WIKI_URL)
        self.assertEqual(page.convert_calls, [])
        self.assertEqual(page.enter_presses, 2)

    def test_helper_conversion_failure_aborts_before_publish(self):
        ns, _, _ = self.make_namespace()
        fixture = self.load_fixture()
        page = self.fixture_page(fixture, convert_result={"success": False, "error": "pending paragraph not found"})
        with self.assertRaisesRegex(base.PublishAbort, "OG plain-link conversion failed before publish"):
            self.render(ns, page, fixture["url"], fallback_urls=[], allow=True)
        self.assertEqual(page.verify_calls, [])

    def test_helper_verification_failure_aborts_before_publish(self):
        ns, _, _ = self.make_namespace()
        fixture = self.load_fixture()
        page = self.fixture_page(fixture, verify_result={"found": False, "markerCount": 0})
        with self.assertRaisesRegex(base.PublishAbort, "OG plain-link verification failed before publish"):
            self.render(ns, page, fixture["url"], fallback_urls=[], allow=True)

    def test_missing_helper_functions_abort_instead_of_downgrading(self):
        ns, _, _ = self.make_namespace()
        fixture = self.load_fixture()
        page = self.fixture_page(
            fixture,
            convert_result={"success": False, "error": "convertPendingToPlainLink unavailable"},
        )
        with self.assertRaisesRegex(base.PublishAbort, "OG plain-link conversion failed before publish"):
            self.render(ns, page, fixture["url"], fallback_urls=[], allow=True)


class PlainLinkAccountingTests(unittest.TestCase):
    def make_namespace(self):
        logs = []

        def fail(message):
            raise base.PublishAbort(message)

        namespace = load_functions(
            {
                "time": base.FakeTime(),
                "log": logs.append,
                "fail": fail,
                "os": base.FakeOS({}),
                "HELPER_JS": "/fake/helper.js",
            }
        )
        return namespace, logs

    def entry(self, url, fallback_urls=()):
        return {"url": url, "fallbackUrls": list(fallback_urls)}

    def test_summary_separates_plain_links_from_card_successes(self):
        ns, _ = self.make_namespace()
        page = PlainLinkPage(
            [
                {"responses": [base.scrap_response(DAUM_PRIMARY, 200, '{"code": 0}')], "status": base.found_status()},
                {"responses": [scrap_40009(WIKI_URL)], "status": base.not_found_status()},
                {"responses": [scrap_40009(WIKI_URL)], "status": base.not_found_status()},
            ],
            cleanup_result={"ogCards": 1, "plainLinks": 1},
        )
        summary = ns["render_og_cards"](
            page,
            [self.entry(DAUM_PRIMARY), self.entry(WIKI_URL)],
            "step5",
            allow_plain_link_fallback=True,
        )
        self.assertEqual(summary["ogCards"], 1)
        self.assertEqual(
            summary["plainLinkFallbacks"],
            [{
                "url": WIKI_URL,
                "reason": "confirmed scrap 500/code=40009 twice, no eligible Daum candidate",
                "phase": "step5",
            }],
        )

    def test_plain_link_never_satisfies_card_count(self):
        # If the editor really rendered only plain links, a cleanup claiming a
        # card for them must fail: expected cards excludes plain links.
        ns, _ = self.make_namespace()
        page = PlainLinkPage(
            [
                {"responses": [scrap_40009(WIKI_URL)], "status": base.not_found_status()},
                {"responses": [scrap_40009(WIKI_URL)], "status": base.not_found_status()},
            ],
            cleanup_result={"ogCards": 1, "plainLinks": 1},
        )
        with self.assertRaisesRegex(base.PublishAbort, "OG card count mismatch before publish: expected 0, got 1"):
            ns["render_og_cards"](page, [self.entry(WIKI_URL)], "step5", allow_plain_link_fallback=True)

    def test_marked_plain_link_count_must_match_fallback_count(self):
        ns, _ = self.make_namespace()
        page = PlainLinkPage(
            [
                {"responses": [scrap_40009(WIKI_URL)], "status": base.not_found_status()},
                {"responses": [scrap_40009(WIKI_URL)], "status": base.not_found_status()},
            ],
            cleanup_result={"ogCards": 0, "plainLinks": 0},
        )
        with self.assertRaisesRegex(base.PublishAbort, "OG plain-link count mismatch before publish: expected 1, got 0"):
            ns["render_og_cards"](page, [self.entry(WIKI_URL)], "step5", allow_plain_link_fallback=True)

    def test_unverifiable_cleanup_with_plain_links_fails_closed(self):
        ns, _ = self.make_namespace()
        page = PlainLinkPage(
            [
                {"responses": [scrap_40009(WIKI_URL)], "status": base.not_found_status()},
                {"responses": [scrap_40009(WIKI_URL)], "status": base.not_found_status()},
            ],
            cleanup_result=None,
        )
        with self.assertRaisesRegex(base.PublishAbort, "OG plain-link count unverifiable before publish"):
            ns["render_og_cards"](page, [self.entry(WIKI_URL)], "step5", allow_plain_link_fallback=True)

    def test_legacy_cleanup_without_plainlinks_key_still_passes_card_only_flow(self):
        ns, _ = self.make_namespace()
        page = PlainLinkPage(
            [{"responses": [], "status": base.found_status()}],
            cleanup_result={"ogCards": 1},
        )
        summary = ns["render_og_cards"](page, [self.entry(DAUM_PRIMARY)], "step5", allow_plain_link_fallback=True)
        self.assertEqual(summary["ogCards"], 1)
        self.assertEqual(summary["plainLinkFallbacks"], [])

    def test_empty_entries_return_empty_summary(self):
        ns, _ = self.make_namespace()
        page = PlainLinkPage([])
        summary = ns["render_og_cards"](page, [], "step5", allow_plain_link_fallback=True)
        self.assertEqual(summary, {"phase": "step5", "ogCards": 0, "plainLinkFallbacks": []})
        self.assertEqual(page.enter_presses, 0)


LEGACY_HELPER_FUNCTIONS = frozenset({
    "prepareOGPlaceholder",
    "prepareOGRetry",
    "getOGCardStatus",
    "cleanupOGResiduals",
})
PLAIN_LINK_HELPER_FUNCTIONS = frozenset({
    "convertPendingToPlainLink",
    "verifyOGPlainLink",
})


class SurfaceAwarePage(PlainLinkPage):
    """PlainLinkPage whose readiness check is answered from an explicit set of
    defined helper function names (instead of scripted booleans), so tests can
    model a legacy helper surface. Injecting HELPER_JS adds `injection_adds`."""

    def __init__(self, attempts, functions, injection_adds=(), **kwargs):
        super().__init__(attempts, **kwargs)
        self.functions = set(functions)
        self.injection_adds = set(injection_adds)

    def add_script_tag(self, path=None):
        super().add_script_tag(path)
        self.functions |= self.injection_adds

    def evaluate(self, script, arg=None):
        if script.startswith("typeof prepareOGPlaceholder"):
            required = set(re.findall(r"typeof (\w+) === 'function'", script))
            assert required, f"unexpected readiness check: {script[:80]}"
            return required <= self.functions
        return super().evaluate(script, arg)


class HelperPreflightTests(unittest.TestCase):
    """ensure_og_helpers compatibility contract: legacy helper surfaces (all
    old functions, no convert/verify) must keep passing every non-opt-in path;
    only the plain-link opt-in additionally requires convert/verify."""

    def make_namespace(self):
        logs = []

        def fail(message):
            raise base.PublishAbort(message)

        namespace = load_functions(
            {
                "time": base.FakeTime(),
                "log": logs.append,
                "fail": fail,
                "os": base.FakeOS({}),
                "HELPER_JS": "/fake/helper.js",
            }
        )
        return namespace, logs

    def test_card_only_flow_accepts_legacy_helper_surface(self):
        ns, _ = self.make_namespace()
        page = SurfaceAwarePage([], functions=LEGACY_HELPER_FUNCTIONS)
        ns["ensure_og_helpers"](page)
        self.assertEqual(page.injected_helpers, [])

    def test_base_contract_still_injects_once_when_missing(self):
        ns, _ = self.make_namespace()
        page = SurfaceAwarePage([], functions=(), injection_adds=LEGACY_HELPER_FUNCTIONS)
        ns["ensure_og_helpers"](page)
        self.assertEqual(page.injected_helpers, ["/fake/helper.js"])

    def test_opt_in_injects_then_rejects_surface_still_missing_convert_verify(self):
        # 주입된 helper 파일마저 구버전이라 convert/verify가 여전히 없으면
        # opt-in 경로는 발행 전에 중단해야 한다.
        ns, _ = self.make_namespace()
        page = SurfaceAwarePage([], functions=LEGACY_HELPER_FUNCTIONS, injection_adds=())
        with self.assertRaisesRegex(base.PublishAbort, "OG helper functions unavailable after helper injection"):
            ns["ensure_og_helpers"](page, require_plain_link_helpers=True)
        self.assertEqual(page.injected_helpers, ["/fake/helper.js"])

    def test_opt_in_accepts_surface_after_injection_adds_convert_verify(self):
        ns, _ = self.make_namespace()
        page = SurfaceAwarePage(
            [], functions=LEGACY_HELPER_FUNCTIONS,
            injection_adds=PLAIN_LINK_HELPER_FUNCTIONS,
        )
        ns["ensure_og_helpers"](page, require_plain_link_helpers=True)
        self.assertEqual(page.injected_helpers, ["/fake/helper.js"])

    def test_opt_in_succeeds_without_injection_when_all_functions_exist(self):
        ns, _ = self.make_namespace()
        page = SurfaceAwarePage(
            [], functions=LEGACY_HELPER_FUNCTIONS | PLAIN_LINK_HELPER_FUNCTIONS,
        )
        ns["ensure_og_helpers"](page, require_plain_link_helpers=True)
        self.assertEqual(page.injected_helpers, [])

    def test_render_path_without_opt_in_runs_on_legacy_surface(self):
        # 런타임 증명: allow 플래그가 꺼진 render_og_cards는 legacy surface
        # (구버전 cleanup 결과 포함)로 카드 플로우를 끝까지 통과한다.
        ns, _ = self.make_namespace()
        page = SurfaceAwarePage(
            [{"responses": [], "status": base.found_status()}],
            functions=LEGACY_HELPER_FUNCTIONS,
            cleanup_result={"ogCards": 1},
        )
        summary = ns["render_og_cards"](page, [{"url": DAUM_PRIMARY, "fallbackUrls": []}], "step5")
        self.assertEqual(summary["ogCards"], 1)
        self.assertEqual(summary["plainLinkFallbacks"], [])
        self.assertEqual(page.injected_helpers, [])

    def test_render_path_threads_allow_flag_into_preflight(self):
        # 런타임 증명(정적 소스 검사 아님): allow=True면 같은 legacy surface가
        # Enter 한 번 누르기 전에 preflight에서 중단된다.
        ns, _ = self.make_namespace()
        page = SurfaceAwarePage(
            [{"responses": [], "status": base.found_status()}],
            functions=LEGACY_HELPER_FUNCTIONS,
            cleanup_result={"ogCards": 1},
        )
        with self.assertRaisesRegex(base.PublishAbort, "OG helper functions unavailable after helper injection"):
            ns["render_og_cards"](
                page, [{"url": DAUM_PRIMARY, "fallbackUrls": []}], "step5",
                allow_plain_link_fallback=True,
            )
        self.assertEqual(page.injected_helpers, ["/fake/helper.js"])
        self.assertEqual(page.enter_presses, 0)


class PlainLinkWiringTests(unittest.TestCase):
    """Static gates: caller opt-in expression, result JSON surfacing, and the
    strict-custom-validator disable are wired identically for Step 5 and the
    recovery path (no drift)."""

    def setUp(self):
        self.source = SCRIPT_PATH.read_text(encoding="utf-8")

    def test_module_call_sites_gate_on_template_and_custom_validator(self):
        gate = "allow_plain_link_fallback=(TEMPLATE == 'daum-trends' and not should_run_og_gate())"
        self.assertIn(f"render_og_cards(page, og_entries, 'step5', {gate})", self.source)
        self.assertIn(f"render_og_cards(page, og_entries, 'recovery', {gate})", self.source)
        # Exactly these two call sites may enable the fallback.
        self.assertEqual(self.source.count("allow_plain_link_fallback=(TEMPLATE"), 2)

    def test_latest_render_summary_feeds_final_result_json(self):
        self.assertIn("og_render_summary = render_og_cards(page, og_entries, 'step5'", self.source)
        self.assertIn("og_render_summary = render_og_cards(page, og_entries, 'recovery'", self.source)
        self.assertIn('result["ogPlainLinkFallbacks"] = og_render_summary[\'plainLinkFallbacks\']', self.source)

    def test_helper_gate_requires_plain_link_functions_only_for_opt_in(self):
        # 기본 계약은 기존 4개 함수만: convert/verify는 opt-in에서만 필수.
        self.assertIn("def ensure_og_helpers(page, require_plain_link_helpers=False):", self.source)
        self.assertIn(
            "ensure_og_helpers(page, require_plain_link_helpers=allow_plain_link_fallback)",
            self.source,
        )
        self.assertIn("typeof convertPendingToPlainLink === 'function'", self.source)
        self.assertIn("typeof verifyOGPlainLink === 'function'", self.source)


if __name__ == "__main__":
    unittest.main()
