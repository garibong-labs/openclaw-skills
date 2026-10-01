"""Behavior tests for the exhausted-pair confirmed-40002 plain-link fallback
(2026-10-01 abort).

Preserved incident: a DCInside mobile minor-gallery post URL failed both
original OG attempts with HTTP 500 + scrap payload code 40002, the strict
pair helper computed the regular-gallery desktop route /board/view (wrong for
minor galleries, whose live canonical route is /mgallery/board/view), and the
single bounded paired attempt failed with the same confirmed 500/40002 — so
the publisher failed the whole post closed. Under the bounded contract, that
exact exhausted three-attempt replay may now degrade the source attribution
to an ordinary hyperlink on the ORIGINAL mobile URL (never the wrong pair) —
only when the caller (daum-trends without a strict custom OG validator) opted
in, every one of the three attempts is a confirmed found=false / observed
scrap / HTTP 500 / code 40002 record in the exact bounded order, the paired
attempt URL equals the helper-computed pair, and the original URL passes the
conservative safe external URL gate. Everything else keeps the existing
fail-closed behavior.

Reuses the ast-extraction fakes from test_publish_post_og_retry and the
plain-link page fakes from test_publish_post_og_plain_link; no network, no
browser.
"""
import json
import unittest
from pathlib import Path

import test_publish_post_og_plain_link as plain
import test_publish_post_og_retry as base


SCRIPT_PATH = base.SCRIPT_PATH
FIXTURE_PATH = Path(__file__).resolve().parent / "fixtures" / "daum-trends-2026-10-01-og-500-40002-exhausted-pair-incident.json"

MINOR_MOBILE = "https://m.dcinside.com/board/newconservativeparty/5768027"
MINOR_WRONG_PAIR = "https://gall.dcinside.com/board/view/?id=newconservativeparty&no=5768027"
MINOR_LIVE_CANONICAL = "https://gall.dcinside.com/mgallery/board/view/?id=newconservativeparty&no=5768027"
REGULAR_MOBILE = base.MOBILE_URL_2026_08_13
REGULAR_DESKTOP = base.DESKTOP_URL_2026_08_13

REASON_40002 = "confirmed scrap 500/code=40002 on original twice and paired fallback once"
LOG_40002 = "confirmed 500/code=40002 on original twice and paired fallback once -> degraded to plain source link"
REASON_40009 = "confirmed scrap 500/code=40009 twice, no eligible Daum candidate"

# The paired attempt leaves the editor's pending paragraph keyed to the wrong
# pair, so the degrade path must rebind it back to the original (one extra
# prepareOGRetry; never a fourth Enter) before converting.
REBIND_CALL = ("retry", {"fromUrl": MINOR_WRONG_PAIR, "toUrl": MINOR_MOBILE})

# Production evaluate scripts, verbatim, for driving the fake directly.
RETRY_SCRIPT = "({fromUrl, toUrl}) => typeof prepareOGRetry === 'function' ? prepareOGRetry(fromUrl, toUrl) : {success: false, error: 'prepareOGRetry unavailable'}"
CONVERT_SCRIPT = "(url) => typeof convertPendingToPlainLink === 'function' ? convertPendingToPlainLink(url) : {success: false, error: 'convertPendingToPlainLink unavailable'}"


def scrap_40002(url, status=500):
    return base.scrap_response(url, status, '{"code": 40002}')


def confirmed_step(url):
    return {"responses": [scrap_40002(url)], "status": base.not_found_status()}


def attempt_record(url, kind, found=False, observed=True, status=500, code="40002"):
    return {
        "url": url,
        "kind": kind,
        "found": found,
        "ogCardCount": 1,
        "scrapObserved": observed,
        "scrapStatus": status,
        "scrapCode": code,
    }


def canonical_attempts(url=MINOR_MOBILE, pair=MINOR_WRONG_PAIR):
    return [
        attempt_record(url, "original"),
        attempt_record(url, "original-retry"),
        attempt_record(pair, "dcinside-paired-fallback"),
    ]


class PendingTrackingPage(plain.PlainLinkPage):
    """PlainLinkPage that models the real editor's single data-og-url-pending
    key: prepareOGPlaceholder sets it, prepareOGRetry rebinds it only when
    fromUrl matches the current key, and convertPendingToPlainLink /
    verifyOGPlainLink succeed only against the current key / converted URL.
    After the paired attempt the key is the paired URL, so converting on the
    original fails here — exactly as in the live editor — unless the degrade
    path rebinds first. `events` records helper-call order for before/after
    assertions. rebind_result (gated by rebind_result_on=(fromUrl, toUrl))
    scripts one specific rebind call's result for fail-closed tests."""

    def __init__(self, attempts, rebind_result=None, rebind_result_on=None, **kwargs):
        super().__init__(attempts, **kwargs)
        self.pending_url = None
        self.converted_url = None
        self.events = []
        self.rebind_result = rebind_result
        self.rebind_result_on = rebind_result_on

    def evaluate(self, script, arg=None):
        if script.startswith("typeof prepareOGPlaceholder"):
            return super().evaluate(script, arg)
        if "prepareOGRetry" in script:
            from_url, to_url = arg["fromUrl"], arg["toUrl"]
            self.prepare_calls.append(("retry", dict(arg)))
            self.events.append(("retry", from_url, to_url))
            if self.rebind_result is not None and self.rebind_result_on == (from_url, to_url):
                result = self.rebind_result
                return dict(result) if isinstance(result, dict) else result
            if self.pending_url != from_url:
                return {"success": False, "error": f"pending paragraph not found for {from_url}"}
            self.pending_url = to_url
            return {"success": True, "fromUrl": from_url, "toUrl": to_url}
        if "prepareOGPlaceholder" in script:
            self.pending_url = arg
            self.events.append(("placeholder", arg))
            return super().evaluate(script, arg)
        if "convertPendingToPlainLink" in script:
            self.events.append(("convert", arg))
            if self.pending_url != arg:
                self.convert_calls.append(arg)
                return {"success": False, "error": f"pending paragraph not found for {arg}"}
            self.pending_url = None
            self.converted_url = arg
            return super().evaluate(script, arg)
        if "verifyOGPlainLink" in script:
            self.events.append(("verify", arg))
            if self.converted_url != arg:
                self.verify_calls.append(arg)
                return {"found": False, "markerCount": 0}
            return super().evaluate(script, arg)
        return super().evaluate(script, arg)


def make_namespace(env=None):
    logs = []

    def fail(message):
        raise base.PublishAbort(message)

    namespace = plain.load_functions(
        {
            "time": base.FakeTime(),
            "log": logs.append,
            "fail": fail,
            "os": base.FakeOS(env or {}),
            "HELPER_JS": "/fake/helper.js",
        }
    )
    return namespace, logs


def load_fixture():
    return json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))


def fixture_page(fixture, **kwargs):
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
    return PendingTrackingPage(attempts, **kwargs)


def render(ns, page, url, phase="step5", fallback_urls=None, allow=False):
    return ns["render_og_card_with_fallback"](
        page, url, 1, phase, fallback_urls, allow_plain_link_fallback=allow
    )


class ExhaustedPairEligibilityTests(unittest.TestCase):
    """Direct contract tests for exhausted_pair_confirmed_500_40002: the exact
    bounded three-attempt sequence is eligible; every deviation is not."""

    def setUp(self):
        ns, _ = make_namespace()
        self.eligible = ns["exhausted_pair_confirmed_500_40002"]

    def test_exact_minor_and_regular_gallery_sequences_are_eligible(self):
        self.assertTrue(self.eligible(MINOR_MOBILE, canonical_attempts()))
        self.assertTrue(
            self.eligible(
                REGULAR_MOBILE, canonical_attempts(REGULAR_MOBILE, REGULAR_DESKTOP)
            )
        )
        # Desktop-input direction pairs back to mobile and is equally bounded.
        self.assertTrue(
            self.eligible(
                REGULAR_DESKTOP, canonical_attempts(REGULAR_DESKTOP, REGULAR_MOBILE)
            )
        )

    def test_urls_without_a_computed_pair_are_never_eligible(self):
        for url in [
            "https://theqoo.net/square/456",
            "https://m.dcinside.com/board/ngm/270135?page=2",
            "https://v.daum.net/v/20260816090000001",
            "",
            None,
        ]:
            with self.subTest(url=url):
                self.assertFalse(self.eligible(url, canonical_attempts(url, MINOR_WRONG_PAIR)))

    def test_wrong_attempt_count_is_not_eligible(self):
        attempts = canonical_attempts()
        self.assertFalse(self.eligible(MINOR_MOBILE, attempts[:2]))
        self.assertFalse(self.eligible(MINOR_MOBILE, attempts + [attempts[2]]))
        self.assertFalse(self.eligible(MINOR_MOBILE, []))
        self.assertFalse(self.eligible(MINOR_MOBILE, None))
        self.assertFalse(self.eligible(MINOR_MOBILE, "not-a-list"))

    def test_wrong_kind_or_order_is_not_eligible(self):
        swapped = canonical_attempts()
        swapped[0], swapped[1] = swapped[1], swapped[0]
        self.assertFalse(self.eligible(MINOR_MOBILE, swapped))

        pair_first = canonical_attempts()
        pair_first[0], pair_first[2] = pair_first[2], pair_first[0]
        self.assertFalse(self.eligible(MINOR_MOBILE, pair_first))

        wrong_kind = canonical_attempts()
        wrong_kind[2]["kind"] = "daum-next-source-fallback"
        self.assertFalse(self.eligible(MINOR_MOBILE, wrong_kind))

    def test_mismatched_attempt_urls_are_not_eligible(self):
        other_post_pair = canonical_attempts(pair="https://gall.dcinside.com/board/view/?id=newconservativeparty&no=5768028")
        self.assertFalse(self.eligible(MINOR_MOBILE, other_post_pair))

        wrong_original = canonical_attempts()
        wrong_original[1]["url"] = REGULAR_MOBILE
        self.assertFalse(self.eligible(MINOR_MOBILE, wrong_original))

        # A paired record carrying the live canonical minor-gallery route is
        # NOT what the helper computed, so it stays ineligible too.
        live_pair = canonical_attempts(pair=MINOR_LIVE_CANONICAL)
        self.assertFalse(self.eligible(MINOR_MOBILE, live_pair))

    def test_any_rendered_card_or_unconfirmed_scrap_is_not_eligible(self):
        for index in range(3):
            for mutation in [
                {"found": True},
                {"scrapObserved": False},
                {"scrapStatus": 200},
                {"scrapStatus": None},
                {"scrapStatus": "500"},
                {"scrapCode": "40009"},
                {"scrapCode": None},
            ]:
                with self.subTest(index=index, mutation=mutation):
                    attempts = canonical_attempts()
                    attempts[index].update(mutation)
                    self.assertFalse(self.eligible(MINOR_MOBILE, attempts))

    def test_non_exact_typed_confirmation_fields_are_not_eligible(self):
        """Fail-closed exact typing: found must be exactly False and
        scrapObserved exactly True (missing keys, None, int/string stand-ins
        all rejected), and scrapStatus must be a non-bool int 500 (bool True
        and float 500.0 rejected despite int-like equality)."""
        for index in range(3):
            for mutation in [
                {"found": None},
                {"found": 0},
                {"found": ""},
                {"found": "false"},
                {"scrapObserved": None},
                {"scrapObserved": 1},
                {"scrapObserved": "true"},
                {"scrapStatus": True},
                {"scrapStatus": 500.0},
            ]:
                with self.subTest(index=index, mutation=mutation):
                    attempts = canonical_attempts()
                    attempts[index].update(mutation)
                    self.assertFalse(self.eligible(MINOR_MOBILE, attempts))
            for missing_key in ["found", "scrapObserved"]:
                with self.subTest(index=index, missing=missing_key):
                    attempts = canonical_attempts()
                    del attempts[index][missing_key]
                    self.assertFalse(self.eligible(MINOR_MOBILE, attempts))

    def test_non_dict_attempt_records_are_not_eligible(self):
        attempts = canonical_attempts()
        attempts[1] = "original-retry"
        self.assertFalse(self.eligible(MINOR_MOBILE, attempts))


class ExhaustedPairFallbackTests(unittest.TestCase):
    # ── fixture integrity (repo-contained incident payload) ─────────────────

    def test_fixture_is_repo_contained_and_matches_incident_shape(self):
        raw = FIXTURE_PATH.read_text(encoding="utf-8")
        fixture = json.loads(raw)
        for leak in ["/Users/", "workspace-ruth", "/tmp/", "runtime.html"]:
            self.assertNotIn(leak, raw)
        self.assertEqual(fixture["template"], "daum-trends")
        self.assertEqual(fixture["url"], MINOR_MOBILE)
        self.assertEqual(fixture["pairedUrl"], MINOR_WRONG_PAIR)
        self.assertEqual(fixture["liveCanonicalUrl"], MINOR_LIVE_CANONICAL)
        self.assertEqual(fixture["fallbackUrls"], [])
        self.assertEqual(
            [record["kind"] for record in fixture["attempts"]],
            ["original", "original-retry", "dcinside-paired-fallback"],
        )
        self.assertEqual(
            [record["url"] for record in fixture["attempts"]],
            [MINOR_MOBILE, MINOR_MOBILE, MINOR_WRONG_PAIR],
        )
        for record in fixture["attempts"]:
            self.assertFalse(record["found"])
            self.assertTrue(record["scrapObserved"])
            self.assertEqual(record["scrapStatus"], 500)
            self.assertEqual(record["scrapCode"], "40002")

    def test_fixture_pair_is_exactly_the_helper_computed_wrong_route(self):
        # Root cause reproduction: the strict helper maps the minor-gallery
        # mobile URL to the regular /board/view route, which differs from the
        # live canonical /mgallery/board/view route.
        ns, _ = make_namespace()
        fixture = load_fixture()
        self.assertEqual(ns["dcinside_paired_og_url"](fixture["url"]), fixture["pairedUrl"])
        self.assertNotEqual(fixture["pairedUrl"], fixture["liveCanonicalUrl"])

    # ── exact incident replay ───────────────────────────────────────────────

    def test_minor_gallery_incident_replay_downgrades_under_opt_in(self):
        ns, logs = make_namespace()
        fixture = load_fixture()
        page = fixture_page(fixture)
        result = render(ns, page, fixture["url"], fallback_urls=fixture["fallbackUrls"], allow=True)
        self.assertEqual(
            result,
            {
                "plainLinkFallback": True,
                "url": MINOR_MOBILE,
                "reason": REASON_40002,
                "phase": "step5",
            },
        )
        # Attribution preserved on the ORIGINAL mobile URL — never the wrong
        # computed pair, never the live canonical guess.
        self.assertEqual(page.convert_calls, [MINOR_MOBILE])
        self.assertEqual(page.verify_calls, [MINOR_MOBILE])
        # Exactly the bounded three attempts: no fourth Enter press, and the
        # downgrade itself is not another card attempt.
        self.assertEqual(page.enter_presses, 3)
        # The paired attempt left the pending paragraph keyed to the wrong
        # pair; before conversion the degrade path rebinds it back to the
        # original with one extra prepareOGRetry (no Enter, no scrap attempt).
        self.assertEqual(page.prepare_calls[-1], REBIND_CALL)
        self.assertEqual(
            page.events,
            [
                ("placeholder", MINOR_MOBILE),
                ("retry", MINOR_MOBILE, MINOR_MOBILE),
                ("retry", MINOR_MOBILE, MINOR_WRONG_PAIR),
                ("retry", MINOR_WRONG_PAIR, MINOR_MOBILE),
                ("convert", MINOR_MOBILE),
                ("verify", MINOR_MOBILE),
            ],
        )
        self.assertIsNone(page.pending_url)
        self.assertTrue(
            any(LOG_40002 in line and MINOR_MOBILE in line and "phase=step5" in line for line in logs)
        )

    def test_incident_replay_without_opt_in_keeps_fail_closed_abort(self):
        ns, _ = make_namespace()
        fixture = load_fixture()
        page = fixture_page(fixture)
        with self.assertRaises(base.PublishAbort) as ctx:
            render(ns, page, fixture["url"], fallback_urls=fixture["fallbackUrls"])
        self.assertIn("OG card render failed before publish", str(ctx.exception))
        self.assertEqual(page.convert_calls, [])
        self.assertEqual(page.enter_presses, 3)
        detail = json.loads(str(ctx.exception).split("before publish: ", 1)[1])
        self.assertEqual(
            [attempt["kind"] for attempt in detail["attempts"]],
            ["original", "original-retry", "dcinside-paired-fallback"],
        )

    def test_recovery_phase_replay_uses_same_path_and_records_phase(self):
        ns, logs = make_namespace()
        fixture = load_fixture()
        page = fixture_page(fixture)
        result = render(
            ns, page, fixture["url"],
            phase="recovery", fallback_urls=fixture["fallbackUrls"], allow=True,
        )
        self.assertEqual(result["phase"], "recovery")
        self.assertEqual(result["reason"], REASON_40002)
        self.assertEqual(page.convert_calls, [MINOR_MOBILE])
        # Same paired→original pending rebind before conversion, no 4th Enter.
        self.assertEqual(page.prepare_calls[-1], REBIND_CALL)
        self.assertEqual(page.enter_presses, 3)
        self.assertTrue(any("phase=recovery" in line and LOG_40002 in line for line in logs))

    # ── regular-gallery pair behavior is unchanged ──────────────────────────

    def test_regular_gallery_pair_success_never_downgrades(self):
        for allow in (False, True):
            with self.subTest(allow=allow):
                ns, _ = make_namespace()
                page = plain.PlainLinkPage([
                    confirmed_step(REGULAR_MOBILE),
                    confirmed_step(REGULAR_MOBILE),
                    {"responses": [base.scrap_response(REGULAR_DESKTOP, 200, '{"code": 0}')], "status": base.found_status()},
                ])
                result = render(ns, page, REGULAR_MOBILE, allow=allow)
                self.assertEqual(result, REGULAR_DESKTOP)
                self.assertEqual(page.convert_calls, [])
                self.assertEqual(page.enter_presses, 3)

    def test_regular_gallery_exhausted_pair_without_opt_in_still_aborts(self):
        ns, _ = make_namespace()
        page = plain.PlainLinkPage([
            confirmed_step(REGULAR_MOBILE),
            confirmed_step(REGULAR_MOBILE),
            confirmed_step(REGULAR_DESKTOP),
        ])
        with self.assertRaisesRegex(base.PublishAbort, "OG card render failed before publish"):
            render(ns, page, REGULAR_MOBILE)
        self.assertEqual(page.convert_calls, [])

    def test_regular_gallery_exhausted_pair_downgrades_only_with_full_contract(self):
        # The runtime cannot know the gallery class from the mobile path, so
        # the policy is sequence/evidence based: a regular-gallery post whose
        # pair also died with all three confirmed 500/40002 may downgrade
        # under opt-in, preserving its original URL.
        ns, _ = make_namespace()
        page = PendingTrackingPage([
            confirmed_step(REGULAR_MOBILE),
            confirmed_step(REGULAR_MOBILE),
            confirmed_step(REGULAR_DESKTOP),
        ])
        result = render(ns, page, REGULAR_MOBILE, allow=True)
        self.assertEqual(
            result,
            {
                "plainLinkFallback": True,
                "url": REGULAR_MOBILE,
                "reason": REASON_40002,
                "phase": "step5",
            },
        )
        self.assertEqual(page.convert_calls, [REGULAR_MOBILE])
        # Equivalent paired→original pending rebind for the regular pair.
        self.assertEqual(
            page.prepare_calls[-1],
            ("retry", {"fromUrl": REGULAR_DESKTOP, "toUrl": REGULAR_MOBILE}),
        )
        self.assertEqual(page.enter_presses, 3)

    # ── every excluded path stays fail-closed even with opt-in ──────────────

    def test_confirmed_40002_without_computed_pair_never_downgrades(self):
        ns, _ = make_namespace()
        url = "https://theqoo.net/square/456"
        page = plain.PlainLinkPage([confirmed_step(url), confirmed_step(url)])
        with self.assertRaisesRegex(base.PublishAbort, "OG card render failed before publish"):
            render(ns, page, url, allow=True)
        self.assertEqual(page.convert_calls, [])
        self.assertEqual(page.enter_presses, 2)

    def test_pair_never_attempted_never_downgrades(self):
        # One confirmed 40002 + one unknown: the paired attempt is never made,
        # so the exhausted-pair contract can never be satisfied.
        ns, _ = make_namespace()
        page = plain.PlainLinkPage([
            confirmed_step(MINOR_MOBILE),
            {"responses": [], "status": base.not_found_status()},
        ])
        with self.assertRaisesRegex(base.PublishAbort, "OG card render failed before publish"):
            render(ns, page, MINOR_MOBILE, allow=True)
        self.assertEqual(page.convert_calls, [])
        self.assertEqual(page.enter_presses, 2)

    def test_unconfirmed_paired_attempt_never_downgrades(self):
        third_cases = {
            "paired unobserved": [],
            "paired unparsable": [base.scrap_response(MINOR_WRONG_PAIR, 500, "<html>error</html>")],
            "paired wrong status": [scrap_40002(MINOR_WRONG_PAIR, status=200)],
            "paired wrong code": [base.scrap_response(MINOR_WRONG_PAIR, 500, '{"code": 40009}')],
        }
        for label, third in third_cases.items():
            with self.subTest(case=label):
                ns, _ = make_namespace()
                page = plain.PlainLinkPage([
                    confirmed_step(MINOR_MOBILE),
                    confirmed_step(MINOR_MOBILE),
                    {"responses": list(third), "status": base.not_found_status()},
                ])
                with self.assertRaisesRegex(base.PublishAbort, "OG card render failed before publish"):
                    render(ns, page, MINOR_MOBILE, allow=True)
                self.assertEqual(page.convert_calls, [], label)
                self.assertEqual(page.enter_presses, 3, label)

    def test_original_attempts_without_status_500_never_downgrade(self):
        # code=40002 twice still triggers the bounded paired attempt, but a
        # non-500 status on the originals fails the exhausted-pair contract.
        ns, _ = make_namespace()
        page = plain.PlainLinkPage([
            {"responses": [scrap_40002(MINOR_MOBILE, status=200)], "status": base.not_found_status()},
            {"responses": [scrap_40002(MINOR_MOBILE, status=200)], "status": base.not_found_status()},
            confirmed_step(MINOR_WRONG_PAIR),
        ])
        with self.assertRaisesRegex(base.PublishAbort, "OG card render failed before publish"):
            render(ns, page, MINOR_MOBILE, allow=True)
        self.assertEqual(page.convert_calls, [])
        self.assertEqual(page.enter_presses, 3)

    def test_mismatched_recomputed_pair_never_downgrades(self):
        # If the eligibility recheck computes a different pair than the one
        # actually attempted, the contract fails closed.
        ns, _ = make_namespace()
        original_paired = ns["dcinside_paired_og_url"]
        calls = {"n": 0}

        def shifting_paired(url):
            calls["n"] += 1
            result = original_paired(url)
            if result and calls["n"] >= 2:
                return result + "9"
            return result

        ns["dcinside_paired_og_url"] = shifting_paired
        page = fixture_page(load_fixture())
        with self.assertRaisesRegex(base.PublishAbort, "OG card render failed before publish"):
            render(ns, page, MINOR_MOBILE, allow=True)
        self.assertEqual(page.convert_calls, [])
        self.assertNotIn(REBIND_CALL, page.prepare_calls)

    def test_unsafe_source_gate_still_applies_before_downgrade(self):
        ns, _ = make_namespace()
        ns["safe_plain_link_source_url"] = lambda url: None
        page = fixture_page(load_fixture())
        with self.assertRaisesRegex(base.PublishAbort, "OG card render failed before publish"):
            render(ns, page, MINOR_MOBILE, allow=True)
        self.assertEqual(page.convert_calls, [])

    def test_helper_conversion_failure_aborts_before_publish(self):
        ns, _ = make_namespace()
        page = fixture_page(load_fixture(), convert_result={"success": False, "error": "pending paragraph not found"})
        with self.assertRaisesRegex(base.PublishAbort, "OG plain-link conversion failed before publish"):
            render(ns, page, MINOR_MOBILE, allow=True)
        self.assertEqual(page.verify_calls, [])

    def test_helper_verification_failure_aborts_before_publish(self):
        ns, _ = make_namespace()
        page = fixture_page(load_fixture(), verify_result={"found": False, "markerCount": 0})
        with self.assertRaisesRegex(base.PublishAbort, "OG plain-link verification failed before publish"):
            render(ns, page, MINOR_MOBILE, allow=True)

    def test_missing_helper_functions_abort_instead_of_downgrading(self):
        ns, _ = make_namespace()
        page = fixture_page(
            load_fixture(),
            convert_result={"success": False, "error": "convertPendingToPlainLink unavailable"},
        )
        with self.assertRaisesRegex(base.PublishAbort, "OG plain-link conversion failed before publish"):
            render(ns, page, MINOR_MOBILE, allow=True)

    def test_rebind_missing_or_failed_aborts_before_conversion(self):
        # If the paired→original pending rebind fails (or the helper surface
        # is missing, or the evaluate result is unstructured), the degrade
        # path must abort with full diagnostics BEFORE any conversion,
        # verification, or publish — and without a fourth Enter press.
        cases = {
            "structured rebind failure": {
                "success": False,
                "error": f"pending paragraph not found for {MINOR_WRONG_PAIR}",
            },
            "helper unavailable": {"success": False, "error": "prepareOGRetry unavailable"},
            "non-dict result": "unexpected-string-result",
        }
        for label, rebind_result in cases.items():
            with self.subTest(case=label):
                ns, _ = make_namespace()
                page = fixture_page(
                    load_fixture(),
                    rebind_result=rebind_result,
                    rebind_result_on=(MINOR_WRONG_PAIR, MINOR_MOBILE),
                )
                with self.assertRaises(base.PublishAbort) as ctx:
                    render(ns, page, MINOR_MOBILE, allow=True)
                message = str(ctx.exception)
                self.assertIn("OG plain-link pending rebind failed before publish", message)
                self.assertEqual(page.convert_calls, [], label)
                self.assertEqual(page.verify_calls, [], label)
                self.assertEqual(page.enter_presses, 3, label)
                self.assertEqual(page.prepare_calls[-1], REBIND_CALL, label)
                detail = json.loads(message.split("before publish: ", 1)[1])
                self.assertEqual(detail["url"], MINOR_MOBILE)
                self.assertEqual(detail["pendingUrl"], MINOR_WRONG_PAIR)
                self.assertEqual(detail["result"], rebind_result)
                self.assertEqual(
                    [attempt["kind"] for attempt in detail["attempts"]],
                    ["original", "original-retry", "dcinside-paired-fallback"],
                )

    def test_fake_models_pending_key_so_unrebound_conversion_fails(self):
        # Guard on the fake itself: after the paired attempt the pending key
        # is the paired URL, so converting on the original fails unless the
        # production flow rebinds first. This is what makes the replay tests
        # above able to catch a missing rebind in the real-editor contract.
        page = PendingTrackingPage([])
        page.evaluate("(url) => prepareOGPlaceholder(url)", MINOR_MOBILE)
        page.evaluate(RETRY_SCRIPT, {"fromUrl": MINOR_MOBILE, "toUrl": MINOR_WRONG_PAIR})
        unrebound = page.evaluate(CONVERT_SCRIPT, MINOR_MOBILE)
        self.assertFalse(unrebound["success"])
        rebind = page.evaluate(RETRY_SCRIPT, {"fromUrl": MINOR_WRONG_PAIR, "toUrl": MINOR_MOBILE})
        self.assertTrue(rebind["success"])
        rebound = page.evaluate(CONVERT_SCRIPT, MINOR_MOBILE)
        self.assertTrue(rebound["success"])
        # A rebind whose fromUrl does not match the current pending key fails
        # structurally, mirroring prepareOGRetry's not-found contract.
        stale = page.evaluate(RETRY_SCRIPT, {"fromUrl": MINOR_WRONG_PAIR, "toUrl": MINOR_MOBILE})
        self.assertFalse(stale["success"])


class ExhaustedPairAccountingTests(unittest.TestCase):
    def entry(self, url, fallback_urls=()):
        return {"url": url, "fallbackUrls": list(fallback_urls)}

    def fixture_steps(self):
        fixture = load_fixture()
        return [
            {
                "responses": [
                    base.scrap_response(
                        record["url"], record["scrapStatus"],
                        json.dumps({"code": int(record["scrapCode"])}),
                    )
                ],
                "status": {"found": record["found"], "ogCardCount": record["ogCardCount"]},
            }
            for record in fixture["attempts"]
        ]

    def test_exhausted_pair_fallback_is_subtracted_from_expected_cards(self):
        ns, _ = make_namespace()
        page = PendingTrackingPage(
            self.fixture_steps(),
            cleanup_result={"ogCards": 0, "plainLinks": 1},
        )
        summary = ns["render_og_cards"](
            page, [self.entry(MINOR_MOBILE)], "step5", allow_plain_link_fallback=True,
        )
        self.assertEqual(summary["ogCards"], 0)
        self.assertEqual(
            summary["plainLinkFallbacks"],
            [{"url": MINOR_MOBILE, "reason": REASON_40002, "phase": "step5"}],
        )

    def test_mixed_40002_and_40009_fallbacks_are_both_surfaced(self):
        ns, _ = make_namespace()
        wiki = plain.WIKI_URL
        steps = self.fixture_steps() + [
            {"responses": [plain.scrap_40009(wiki)], "status": base.not_found_status()},
            {"responses": [plain.scrap_40009(wiki)], "status": base.not_found_status()},
        ]
        page = PendingTrackingPage(steps, cleanup_result={"ogCards": 0, "plainLinks": 2})
        summary = ns["render_og_cards"](
            page,
            [self.entry(MINOR_MOBILE), self.entry(wiki)],
            "step5",
            allow_plain_link_fallback=True,
        )
        self.assertEqual(summary["ogCards"], 0)
        self.assertEqual(
            summary["plainLinkFallbacks"],
            [
                {"url": MINOR_MOBILE, "reason": REASON_40002, "phase": "step5"},
                {"url": wiki, "reason": REASON_40009, "phase": "step5"},
            ],
        )

    def test_exhausted_pair_plain_link_never_satisfies_card_count(self):
        ns, _ = make_namespace()
        page = PendingTrackingPage(
            self.fixture_steps(),
            cleanup_result={"ogCards": 1, "plainLinks": 1},
        )
        with self.assertRaisesRegex(base.PublishAbort, "OG card count mismatch before publish: expected 0, got 1"):
            ns["render_og_cards"](page, [self.entry(MINOR_MOBILE)], "step5", allow_plain_link_fallback=True)

    def test_marked_plain_link_count_must_match_fallback_count(self):
        ns, _ = make_namespace()
        page = PendingTrackingPage(
            self.fixture_steps(),
            cleanup_result={"ogCards": 0, "plainLinks": 0},
        )
        with self.assertRaisesRegex(base.PublishAbort, "OG plain-link count mismatch before publish: expected 1, got 0"):
            ns["render_og_cards"](page, [self.entry(MINOR_MOBILE)], "step5", allow_plain_link_fallback=True)

    def test_paired_success_still_counts_as_a_card(self):
        ns, _ = make_namespace()
        page = plain.PlainLinkPage(
            [
                confirmed_step(REGULAR_MOBILE),
                confirmed_step(REGULAR_MOBILE),
                {"responses": [base.scrap_response(REGULAR_DESKTOP, 200, '{"code": 0}')], "status": base.found_status()},
            ],
            cleanup_result={"ogCards": 1, "plainLinks": 0},
        )
        summary = ns["render_og_cards"](
            page, [self.entry(REGULAR_MOBILE)], "step5", allow_plain_link_fallback=True,
        )
        self.assertEqual(summary["ogCards"], 1)
        self.assertEqual(summary["plainLinkFallbacks"], [])


class ExhaustedPairWiringTests(unittest.TestCase):
    """Static gates: caller opt-in sites are unchanged, and the exhausted-pair
    policy exists at exactly one site sharing the degrade helper."""

    def setUp(self):
        self.source = SCRIPT_PATH.read_text(encoding="utf-8")

    def test_caller_gating_is_unchanged(self):
        gate = "allow_plain_link_fallback=(TEMPLATE == 'daum-trends' and not should_run_og_gate())"
        self.assertIn(f"render_og_cards(page, og_entries, 'step5', {gate})", self.source)
        self.assertIn(f"render_og_cards(page, og_entries, 'recovery', {gate})", self.source)
        self.assertEqual(self.source.count("allow_plain_link_fallback=(TEMPLATE"), 2)

    def test_single_shared_degrade_policy_site(self):
        self.assertEqual(self.source.count("def degrade_to_plain_link("), 1)
        self.assertEqual(self.source.count("def exhausted_pair_confirmed_500_40002("), 1)
        self.assertEqual(self.source.count(f"'{REASON_40002}'"), 1)
        self.assertEqual(self.source.count(f"'{REASON_40009}'"), 1)
        # Exactly one caller (the exhausted-pair site) passes a pending_url,
        # and the rebind fail-closed diagnostic exists at one site inside the
        # shared degrade helper.
        self.assertEqual(self.source.count("pending_url=paired_url,"), 1)
        self.assertEqual(self.source.count("OG plain-link pending rebind failed before publish"), 1)


if __name__ == "__main__":
    unittest.main()
