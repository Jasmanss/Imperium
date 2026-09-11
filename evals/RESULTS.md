# Eval Results

_Generated 2026-09-10 21:29 on commit `cfb29d9` by `python3 evals/runner.py`. Do not edit by hand._

## Summary

| Suite | Measures | Result |
|---|---|---|
| Offline | Safety and reliability layers (regression suite, must stay at 100%) | **142/142 passed** |
| Mutation check | Deliberately broken safety properties the offline suite detects | **23/23 caught** |
| Live | End-to-end task success on a real Mac | Not run: not requested (run with --live on a Mac with ANTHROPIC_API_KEY set) |

## Offline suite by category

| Category | Passed |
|---|---|
| audit | 5/5 |
| auth | 22/22 |
| classification | 17/17 |
| confirm_flow | 8/8 |
| handler_escaping | 3/3 |
| permission_gate | 6/6 |
| policy_gate | 57/57 |
| repair_loop | 11/11 |
| tracing | 7/7 |
| validator | 6/6 |

## Mutation check

Each row deliberately breaks one safety property in memory, then reruns the offline suite. A mutation counts as caught when at least one task fails.

| Mutation | Caught | Detected by |
|---|---|---|
| Auth middleware treats every path as public | yes | `auth_rejects_missing_token`, `auth_rejects_wrong_token`, `auth_rejects_truncated_token` +11 more |
| Token comparison accepts any token | yes | `auth_rejects_wrong_token`, `auth_rejects_truncated_token`, `auth_rejects_extended_token` |
| Destructive actions skip confirmation | yes | `gate_parks_imessage`, `gate_parks_email`, `gate_parks_git_push` +8 more |
| Pending confirmations are replayable | yes | `confirm_id_is_single_use` |
| Pending confirmations never expire | yes | `confirm_id_expires_after_ttl` |
| Policy gate allows every script | yes | `gate_blocks_send_when_classifier_misses_it`, `policy_blocks_shell_escape`, `policy_blocks_shell_escape_any_case` +41 more |
| App allowlist is not enforced | yes | `gate_blocks_send_when_classifier_misses_it`, `policy_blocks_non_allowlisted_app`, `policy_blocks_non_allowlisted_app_short_form` +12 more |
| Allowlist only checks `tell application` (the Phase 1 gate) | yes | `policy_blocks_activate_application_form`, `policy_blocks_launch_application_form`, `policy_blocks_system_events_process_form` +4 more |
| Running strings as AppleScript not banned | yes | `policy_blocks_run_script_string_eval`, `policy_blocks_load_script` |
| Mail and Messages sends skip confirmation | yes | `gate_blocks_send_when_classifier_misses_it`, `confirm_marks_only_confirmed_commands`, `policy_blocks_unconfirmed_mail_send` +7 more |
| Confirm route does not mark commands confirmed | yes | `confirm_marks_only_confirmed_commands` |
| Bans match inside quoted strings | yes | `policy_allows_password_inside_email_text`, `policy_allows_shutdown_inside_note_text`, `policy_allows_send_inside_mail_draft_text` |
| Comments not understood by the policy gate | yes | `policy_blocks_send_hidden_between_line_comments`, `policy_blocks_shell_hidden_between_hash_comments`, `policy_allows_block_comment_with_quoted_text` |
| Line comments end only at LF, not CR | yes | `policy_blocks_shell_after_cr_terminated_comment`, `policy_blocks_mail_send_after_cr_terminated_comment` |
| Applications may be named by variables or indexes | yes | `policy_blocks_app_named_by_variable`, `policy_blocks_process_named_by_variable`, `policy_blocks_process_by_index` +1 more |
| Handler values interpolated without escaping | yes | `handler_contact_name_stays_quoted` |
| Timed-out or confirmed commands are re-run | yes | `repair_not_rerun_after_timeout`, `repair_not_rerun_after_execution_error_in_confirmed_command` |
| Executed scripts not recorded | yes | `trace_records_executed_script` |
| Latency percentile uses a rounded index | yes | `stats_percentile_is_nearest_rank` |
| Email commands not recognised | yes | `gate_parks_email`, `confirm_ids_are_independent`, `classify_email` +3 more |
| Repair loop disabled | yes | `repair_fixes_runtime_error`, `repair_fixes_validation_error`, `repair_is_bounded` +5 more |
| Token usage not recorded | yes | `trace_records_clean_command`, `trace_sums_tokens_across_repair`, `trace_records_failed_command` +1 more |
| Audit schema migration skipped | yes | `gate_parks_imessage`, `gate_blocks_send_when_classifier_misses_it`, `trace_records_clean_command` +9 more |

## Live suite

Not run: not requested (run with --live on a Mac with ANTHROPIC_API_KEY set). 11 live tasks are defined in `tasks.yaml` and run with `python3 evals/runner.py --live`. No live numbers are reported until they have actually been measured.

## All tasks

| Task | Suite | Category | Result | Detail |
|---|---|---|---|---|
| `auth_rejects_missing_token` | offline | auth | pass | HTTP 401 |
| `auth_rejects_wrong_token` | offline | auth | pass | HTTP 401 |
| `auth_rejects_truncated_token` | offline | auth | pass | HTTP 401 |
| `auth_rejects_extended_token` | offline | auth | pass | HTTP 401 |
| `auth_rejects_token_without_bearer_scheme` | offline | auth | pass | HTTP 401 |
| `auth_rejects_basic_scheme` | offline | auth | pass | HTTP 401 |
| `auth_rejects_empty_bearer` | offline | auth | pass | HTTP 401 |
| `auth_rejects_token_in_query_string` | offline | auth | pass | HTTP 401 |
| `auth_accepts_valid_token` | offline | auth | pass | HTTP 200 |
| `auth_accepts_lowercase_bearer_scheme` | offline | auth | pass | HTTP 200 |
| `auth_denies_unknown_route_before_routing` | offline | auth | pass | HTTP 401 |
| `auth_unknown_route_with_token_is_404` | offline | auth | pass | HTTP 404 |
| `auth_health_check_is_public` | offline | auth | pass | HTTP 200 |
| `auth_frontend_is_public` | offline | auth | pass | HTTP 200 |
| `auth_public_prefix_is_exact` | offline | auth | pass | HTTP 401 |
| `auth_protects_text_command` | offline | auth | pass | HTTP 401 |
| `auth_protects_confirm` | offline | auth | pass | HTTP 401 |
| `auth_protects_stats` | offline | auth | pass | HTTP 401 |
| `auth_options_request_never_reaches_handler` | offline | auth | pass | HTTP 405 |
| `auth_removed_git_route_stays_removed` | offline | auth | pass | HTTP 404 |
| `auth_removed_message_route_stays_removed` | offline | auth | pass | HTTP 404 |
| `pairing_token_stored_privately` | offline | auth | pass | mode 0o600, 43 chars, persistent |
| `gate_parks_imessage` | offline | permission_gate | pass | HTTP 200 |
| `gate_parks_email` | offline | permission_gate | pass | HTTP 200 |
| `gate_parks_git_push` | offline | permission_gate | pass | HTTP 200 |
| `gate_parks_quit_everything` | offline | permission_gate | pass | HTTP 200 |
| `gate_rejects_empty_command` | offline | permission_gate | pass | HTTP 200 |
| `gate_blocks_send_when_classifier_misses_it` | offline | permission_gate | pass | tokens 800/90, repairs 0 |
| `confirm_nothing_runs_before_confirmation` | offline | confirm_flow | pass | no execution before confirm |
| `confirm_unknown_id_rejected` | offline | confirm_flow | pass | unknown id rejected |
| `confirm_runs_server_stored_command_not_client_input` | offline | confirm_flow | pass | executes server stored command |
| `confirm_id_is_single_use` | offline | confirm_flow | pass | single use |
| `confirm_id_expires_after_ttl` | offline | confirm_flow | pass | expires |
| `confirm_requires_auth` | offline | confirm_flow | pass | confirm requires auth |
| `confirm_ids_are_independent` | offline | confirm_flow | pass | ids are independent |
| `confirm_marks_only_confirmed_commands` | offline | confirm_flow | pass | confirmation marks only confirmed commands |
| `policy_blocks_shell_escape` | offline | policy_gate | pass | shell execution from AppleScript is not allowed |
| `policy_blocks_shell_escape_any_case` | offline | policy_gate | pass | shell execution from AppleScript is not allowed |
| `policy_blocks_shell_escape_odd_whitespace` | offline | policy_gate | pass | shell execution from AppleScript is not allowed |
| `policy_blocks_run_script_string_eval` | offline | policy_gate | pass | running strings or files as AppleScript is not allowed |
| `policy_blocks_keychain_password_read` | offline | policy_gate | pass | scripts may not reference passwords |
| `policy_blocks_empty_trash` | offline | policy_gate | pass | emptying trash requires manual action |
| `policy_blocks_file_deletion` | offline | policy_gate | pass | deleting files requires manual action |
| `policy_blocks_shutdown` | offline | policy_gate | pass | power/session control is not allowed |
| `policy_blocks_restart` | offline | policy_gate | pass | power/session control is not allowed |
| `policy_blocks_disk_erase` | offline | policy_gate | pass | disk operations are not allowed |
| `policy_blocks_non_allowlisted_app` | offline | policy_gate | pass | app "Terminal" is not in the allowlist (edit ~/.imperium/permissions.json to allow it) |
| `policy_blocks_non_allowlisted_app_short_form` | offline | policy_gate | pass | app "Terminal" is not in the allowlist (edit ~/.imperium/permissions.json to allow it) |
| `policy_blocks_activate_application_form` | offline | policy_gate | pass | app "Terminal" is not in the allowlist (edit ~/.imperium/permissions.json to allow it) |
| `policy_blocks_launch_application_form` | offline | policy_gate | pass | app "Terminal" is not in the allowlist (edit ~/.imperium/permissions.json to allow it) |
| `policy_blocks_application_id_form` | offline | policy_gate | pass | app "com.apple.Terminal" is not in the allowlist (edit ~/.imperium/permissions.json to allow it) |
| `policy_blocks_system_events_process_form` | offline | policy_gate | pass | app "Terminal" is not in the allowlist (edit ~/.imperium/permissions.json to allow it) |
| `policy_blocks_process_name_filter` | offline | policy_gate | pass | app "Terminal" is not in the allowlist (edit ~/.imperium/permissions.json to allow it) |
| `policy_blocks_process_name_fragment` | offline | policy_gate | pass | process filter "Term" could match a shell-capable app |
| `policy_blocks_finder_opening_terminal_bundle` | offline | policy_gate | pass | app "Terminal.app" is not in the allowlist (edit ~/.imperium/permissions.json to allow it) |
| `policy_blocks_hfs_path_to_terminal_bundle` | offline | policy_gate | pass | app "Terminal.app" is not in the allowlist (edit ~/.imperium/permissions.json to allow it) |
| `policy_blocks_load_script` | offline | policy_gate | pass | running strings or files as AppleScript is not allowed |
| `policy_blocks_raw_file_read` | offline | policy_gate | pass | raw file access is not allowed |
| `policy_blocks_open_for_access` | offline | policy_gate | pass | raw file access is not allowed |
| `policy_blocks_move_to_trash` | offline | policy_gate | pass | deleting files requires manual action |
| `policy_blocks_chrome_javascript` | offline | policy_gate | pass | running JavaScript in the browser is not allowed |
| `policy_blocks_safari_javascript` | offline | policy_gate | pass | running JavaScript in the browser is not allowed |
| `policy_blocks_unconfirmed_mail_send` | offline | policy_gate | pass | sending mail or messages requires confirmation — phrase it as "send an email to…" or "send a text to…" so you can confirm it on your phone |
| `policy_blocks_unconfirmed_imessage_send` | offline | policy_gate | pass | sending mail or messages requires confirmation — phrase it as "send an email to…" or "send a text to…" so you can confirm it on your phone |
| `policy_blocks_send_hidden_between_line_comments` | offline | policy_gate | pass | sending mail or messages requires confirmation — phrase it as "send an email to…" or "send a text to…" so you can confirm it on your phone |
| `policy_blocks_shell_hidden_between_hash_comments` | offline | policy_gate | pass | shell execution from AppleScript is not allowed |
| `policy_blocks_shell_after_cr_terminated_comment` | offline | policy_gate | pass | shell execution from AppleScript is not allowed |
| `policy_blocks_mail_send_after_cr_terminated_comment` | offline | policy_gate | pass | sending mail or messages requires confirmation — phrase it as "send an email to…" or "send a text to…" so you can confirm it on your phone |
| `policy_blocks_raw_apple_event` | offline | policy_gate | pass | raw Apple event codes are not allowed |
| `policy_blocks_application_file_id` | offline | policy_gate | pass | app "com.apple.Terminal" is not in the allowlist (edit ~/.imperium/permissions.json to allow it) |
| `policy_blocks_hfs_bundle_path_with_trailing_colon` | offline | policy_gate | pass | app "Terminal.app" is not in the allowlist (edit ~/.imperium/permissions.json to allow it) |
| `policy_blocks_bundle_id_literal` | offline | policy_gate | pass | bundle id "com.googlecode.iterm2" cannot be checked against the allowlist |
| `policy_blocks_line_continuation_before_app_name` | offline | policy_gate | pass | app "Terminal" is not in the allowlist (edit ~/.imperium/permissions.json to allow it) |
| `policy_blocks_app_named_by_variable` | offline | policy_gate | pass | applications and processes must be named with a string literal |
| `policy_blocks_process_named_by_variable` | offline | policy_gate | pass | applications and processes must be named with a string literal |
| `policy_blocks_process_by_index` | offline | policy_gate | pass | applications and processes must be named with a string literal |
| `policy_blocks_process_name_filter_with_variable` | offline | policy_gate | pass | applications and processes must be named with a string literal |
| `policy_allows_allowlisted_app` | offline | policy_gate | pass | allowed |
| `policy_allows_password_inside_email_text` | offline | policy_gate | pass | allowed |
| `policy_allows_shutdown_inside_note_text` | offline | policy_gate | pass | allowed |
| `policy_allows_frontmost_process_query` | offline | policy_gate | pass | allowed |
| `policy_allows_allowlisted_process_form` | offline | policy_gate | pass | allowed |
| `policy_allows_chrome_new_tab_template` | offline | policy_gate | pass | allowed |
| `policy_allows_confirmed_mail_send` | offline | policy_gate | pass | allowed |
| `policy_allows_send_inside_mail_draft_text` | offline | policy_gate | pass | allowed |
| `policy_allows_file_name_filter` | offline | policy_gate | pass | allowed |
| `policy_allows_allowlisted_bundle_path` | offline | policy_gate | pass | allowed |
| `policy_allows_comment_with_quotes` | offline | policy_gate | pass | allowed |
| `policy_allows_dashes_and_hash_inside_strings` | offline | policy_gate | pass | allowed |
| `policy_allows_block_comment_with_quoted_text` | offline | policy_gate | pass | allowed |
| `policy_allows_path_to_frontmost_application` | offline | policy_gate | pass | allowed |
| `policy_allows_process_name_is_not_filter` | offline | policy_gate | pass | allowed |
| `policy_allows_every_process_enumeration` | offline | policy_gate | pass | allowed |
| `validator_rejects_open_location` | offline | validator | pass | BANNED: 'open location' opens a new Chrome window. Use the build_chrome_new_tab_script() template instead. |
| `validator_rejects_open_a_chrome` | offline | validator | pass | BANNED: shell-style 'open -a … Chrome' opens a separate process/window. Use the build_chrome_new_tab_script() template instead. |
| `validator_rejects_placeholder_url_variable` | offline | validator | pass | Undefined or unsafe placeholder variable (theURL); use quoted URL/string literals instead. |
| `validator_rejects_urlstring_variable` | offline | validator | pass | Undefined or unsafe placeholder variable (urlString); use quoted URL/string literals instead. |
| `validator_allows_placeholder_words_inside_strings` | offline | validator | pass | valid |
| `validator_allows_chrome_new_tab_template` | offline | validator | pass | valid |
| `repair_not_used_when_script_succeeds` | offline | repair_loop | pass | rc=0, repairs=0 |
| `repair_fixes_runtime_error` | offline | repair_loop | pass | rc=0, repairs=1 |
| `repair_fixes_validation_error` | offline | repair_loop | pass | rc=0, repairs=1 |
| `repair_is_bounded` | offline | repair_loop | pass | rc=1, repairs=2 |
| `repair_never_retries_a_policy_block` | offline | repair_loop | pass | rc=1, repairs=0 |
| `repair_failure_is_graceful` | offline | repair_loop | pass | rc=1, repairs=1 |
| `repair_output_still_passes_policy_gate` | offline | repair_loop | pass | rc=1, repairs=1 |
| `repair_disallowed_script_is_blocked_before_validation` | offline | repair_loop | pass | rc=1, repairs=0 |
| `repair_not_rerun_after_timeout` | offline | repair_loop | pass | rc=1, repairs=0 |
| `repair_not_rerun_after_execution_error_in_confirmed_command` | offline | repair_loop | pass | rc=1, repairs=0 |
| `repair_fixes_syntax_error_in_confirmed_command` | offline | repair_loop | pass | rc=0, repairs=1 |
| `trace_records_clean_command` | offline | tracing | pass | tokens 1200/80, repairs 0 |
| `trace_sums_tokens_across_repair` | offline | tracing | pass | tokens 1400/100, repairs 1 |
| `trace_records_failed_command` | offline | tracing | pass | tokens 1500/110, repairs 2 |
| `trace_isolated_between_concurrent_commands` | offline | tracing | pass | per-command token counts [3, 7, 11] |
| `trace_recording_outside_command_is_noop` | offline | tracing | pass | recording outside a command is a no-op |
| `trace_audits_command_that_crashes` | offline | tracing | pass | crash recorded as a failed command |
| `trace_records_executed_script` | offline | tracing | pass | tokens 500/40, repairs 0 |
| `audit_migrates_legacy_database` | offline | audit | pass | 16 columns, 2 rows |
| `stats_aggregates_executions` | offline | audit | pass | 10 commands aggregated |
| `stats_empty_database` | offline | audit | pass | 0 commands aggregated |
| `stats_percentile_is_nearest_rank` | offline | audit | pass | 13 commands aggregated |
| `stats_endpoint_returns_aggregates` | offline | audit | pass | HTTP 200 |
| `handler_spotify_query_stays_quoted` | offline | handler_escaping | pass | 1 script(s); the value stayed inside its literal |
| `handler_imessage_text_stays_quoted` | offline | handler_escaping | pass | 1 script(s); the value stayed inside its literal |
| `handler_contact_name_stays_quoted` | offline | handler_escaping | pass | 1 script(s); the value stayed inside its literal |
| `classify_email` | offline | classification | pass | -> email_send |
| `classify_imessage` | offline | classification | pass | -> message_send |
| `classify_git_push` | offline | classification | pass | -> git_push |
| `classify_quit_everything` | offline | classification | pass | -> close_all_apps |
| `classify_spotify` | offline | classification | pass | -> spotify |
| `classify_generic_command` | offline | classification | pass | -> applescript_general |
| `classify_git_commit_with_message_is_not_imessage` | offline | classification | pass | -> git |
| `classify_email_mentioning_spotify` | offline | classification | pass | -> email_send |
| `classify_forward_email` | offline | classification | pass | -> email_send |
| `classify_message_verb` | offline | classification | pass | -> message_send |
| `classify_text_verb` | offline | classification | pass | -> message_send |
| `classify_imessage_verb` | offline | classification | pass | -> message_send |
| `classify_quit_all_apps_phrase` | offline | classification | pass | -> close_all_apps |
| `classify_text_saying_with_message_is_imessage` | offline | classification | pass | -> message_send |
| `classify_email_saying_with_message_is_email` | offline | classification | pass | -> email_send |
| `classify_text_mentioning_status_is_imessage` | offline | classification | pass | -> message_send |
| `classify_commit_message_mentioning_text_is_git` | offline | classification | pass | -> git |
