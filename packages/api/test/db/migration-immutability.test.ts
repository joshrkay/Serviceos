import { createHash } from 'crypto';
import { describe, it, expect } from 'vitest';
import { MIGRATIONS } from '../../src/db/schema';

/**
 * Migration immutability check.
 *
 * Why: production deploys crashed in May 2026 after PR #218's migration
 * (`055_create_leads`) was renamed and mutated in-place by PR #223
 * (`057_create_leads`, adding a generated `phone_normalized` column).
 * `getMigrationSQL()` runs every migration as `CREATE TABLE IF NOT
 * EXISTS …`, so the new column was a no-op on existing databases and
 * the indexes that referenced it crashed boot with `column
 * "phone_normalized" does not exist`. PR #225 (`058_leads_phone_normalized`)
 * fixed it by moving the column into a new migration with `ALTER TABLE
 * ADD COLUMN IF NOT EXISTS`.
 *
 * This test prevents the same shape of mistake from re-occurring: any
 * change to a *value* in the `MIGRATIONS` map must show up here with an
 * explicit hash update, which forces the author to think about whether
 * the migration has shipped to any environment yet. The failure message
 * tells them exactly what to do (revert + add a new migration vs.
 * update the snapshot when truly pre-deploy).
 *
 * Adding a new migration: bake a new entry below. The key must be
 * lexicographically greater than every existing key (the schema runner
 * concatenates `Object.values(MIGRATIONS)` in insertion order; renaming
 * existing keys is also forbidden because production uses keys for
 * change-detection if we ever add per-migration tracking).
 *
 * Removing a migration: forbidden. Production may have already run it.
 */

/**
 * SHA-256 of every migration value as of the last review. To regenerate
 * after intentional churn, run:
 *
 *   npx tsx -e "
 *     import { MIGRATIONS } from './packages/api/src/db/schema';
 *     import { createHash } from 'crypto';
 *     for (const [k, v] of Object.entries(MIGRATIONS)) {
 *       // Normalize line endings to match hashMigration() below; otherwise
 *       // a Windows checkout with core.autocrlf=true would emit CRLF and
 *       // produce hashes that disagree with the test runner.
 *       const normalized = v.replace(/\r\n/g, '\n');
 *       const h = createHash('sha256').update(normalized).digest('hex');
 *       console.log(\`  ['\${k}', '\${h}'],\`);
 *     }
 *   "
 *
 * and paste the output below. Reviewers should ask "did this migration
 * already deploy?" before approving any churn.
 */
const SNAPSHOT: ReadonlyArray<readonly [string, string]> = [
  ['001_create_tenants', '72b9d1e5edffac6f4ef6e92e183795d5ffba9cf3d09c15e0596080cffcd73ba2'],
  ['002_create_users', '130fb74d748579d73fbad39a2214029cf63f009a63451de7acac4d7249b991d0'],
  ['003_create_audit_events', 'a27a568eaacacc933c9e4f5bbb2d568c9e9c2f095c6d85b530ff44737a1021fb'],
  ['004_create_files', '25918c939c9fe36a07cf060d8c9120812e48b0232f17a93c0e7024a5b412ae15'],
  ['005_create_conversations', '6bbe85c35884edad956e94de853ffc446e4db4fa9538f7483950057c76cee2a1'],
  ['006_create_messages', '22331f5a1bbda0771b7863b239be7c0d367139517012ffbe2e63181023ad0510'],
  ['007_create_voice_recordings', '8d9cdda34e233b4bf44d7d1d598601863d355bee452fede0d5dc4fd559708cf4'],
  ['008_create_ai_runs', 'e237dfdca7a7406495439e6e14ba150d5b1165588e75b4f8da3fe4df1c28465c'],
  ['009_create_prompt_versions', '654d3d88161c80dad0cb8d3ad50798f6295b076b6e79af4eeb192dc1d91a7737'],
  ['010_create_document_revisions', '71601702f6c2b8175a392e48ae534deec7e0acd610b8f3c4be2e82941d269c51'],
  ['011_create_diff_analyses', '72a859852c8a53f000c9dea568508479a6f729e73c7ae32bab53005642fe13bb'],
  ['012_create_webhook_events', '821bc47fe7521d634e69be7c8b4e8be7dc2340c42e9c883bdf6a374a3ce78881'],
  ['013_create_tenant_settings', '8f5fc3a6e94732e81c7959d49374a4e67a96a5d9d29f9a7c82bf08a77762a489'],
  ['014_create_customers', 'dac122dc7f2bf60403ec84f541e60b7de5e29558d770e1dcc93d8c577c2368a6'],
  ['015_create_service_locations', '21aaeac466689cc3a964b3716c53d2395d1c8e57dfe7c39a7ceff7c4e243c4ff'],
  ['016_create_jobs', 'd13851154b8b98a02c7f73b59d5be99c813b7d04aecef004ace5dc9d39723c31'],
  ['017_create_job_timeline_events', 'b249f4702f2904b120a5b3b6a01d0372e701f768bd2c50e53cea7bedd99f6e47'],
  ['018_create_appointments', '5b9aab1df3fabe35d130752b5af9d7531d7dc92da97a41e7fab601b5cfe6815c'],
  // 070's region CHECK was changed to NOT VALID on this branch (3db4b4a) — the
  // runner re-executes every migration on every boot (no ledger) and the named
  // constraint is DROP'd + re-ADD'd each time, so a validating ADD CONSTRAINT
  // re-checked all rows and bricked deploys (23514) on any NULL-region row that
  // the relaxed 088 constraint allows. NOT VALID is the only fix that takes
  // effect at the 070 step itself; hash regenerated to lock in the edit.
  ['070_tenant_location_and_integrations', '56a32f2c0274b18ebcae94c747dc0885660078edc629b168ce1bc67fb887bea0'],
  ['019_create_appointment_assignments', 'e9394cf3cdc8c89bc8b7f12556d397a86bfdd5a980f3b39af70e45815e98c35b'],
  ['020_create_estimates', 'b4b9e04bbe669956419eb7083e1e8b441db7398aaa8e9e4d80f683c68792cc4d'],
  ['021_create_estimate_line_items', '43b3f8ba9491c53f7701961bb28eae9cddd4c7d9a3c1c908a5d50b8c1a65cabc'],
  ['022_create_estimate_provenance', 'f08727bf56362dc726fe0677d95fe9b82e208d20cc6faced93efdad7aeacc911'],
  ['023_create_estimate_approvals', '33be6b28a45354a1abde1c78c89fcb82420e1a0b928adb722190ae5f87501574'],
  ['024_create_invoices', '84d0d5f9253fe0e7143f0ac53e832986c1df85dbbcfdb21861fb542203d8d269'],
  ['025_create_invoice_line_items', '0cc116f87c72f55578b5b3c4f9892327e94744d561a66cda7bbe97363f9c012d'],
  ['026_create_payments', '5a171ac98fd2e35ca0591f63a3a833d3c87ea927d8516c17f997483ae2b0bae5'],
  ['027_create_proposals', '6c768deeeb9a03f441746eda94b4a1b2a38ccff0c47f1c0ab49c4f522a724128'],
  ['028_create_proposal_analytics', '4ac49dee7cc83b49547ba53a50a5574aefdea816c2c5297bb7cc71d167ec4c50'],
  ['029_create_evaluation_snapshots', 'b8b2c6d245799711b48440e25da640326c44e451999a95cc067ccf02ad507079'],
  ['030_create_llm_cache', 'da8cdfa0fd06fe8779a9e9b6991b26dbbd6cd4eff9b1e9c6511cf37ec95364d1'],
  ['031_create_provider_health', '5d0e2d79f7eb6a99847adcc2dd1b585aaf0895e6b85e52fc4de7457ce0fa7ffe'],
  ['032_create_vertical_packs', 'c0777542fb1c60f76bcd0cd53504affff12842af662ff7a5564616606110fc53'],
  ['033_create_estimate_templates', '3f8424adefbd2a83b6f53c94cae70c2ffcb18b54908d6a3c1be7498aa0c2837e'],
  ['034_create_service_bundles', '26c13dbce97aeaf5514c6958a2851d5dcfab751e6b301fb90d73ba25cf078779'],
  ['035_create_wording_preferences', '58ea95952d81d59c87732fadc02f7324e8d4aa0456109db5fca88334c2ef8c51'],
  ['036_create_quality_metrics', '09bb4206c3c1e1c37a2b3c2eda621729c22b0d9e185fcdaf9d3e835c0742f12e'],
  ['037_create_notes', '94e192f02ba3b528263570b51933ca4ce011ce9688c17a7707e276f54489f5f0'],
  ['038_create_pack_activations', 'ec634010ea4ef3a4d325a9f3f9d24071126aba981d0c1357c4eb27c3747c224e'],
  ['039_proposals_v2', '4b034ecf0c4d5426d4385d18923e236fa2a922660e2faa08208c95c9b4e8b7ee'],
  ['040_create_technician_location_pings', '6b0002aeafa546016ef19bb95b7eaeed4c82e312f29c9f2a384b7484ddfd52ea'],
  ['041_create_catalog_items', '3323c01a7efc6958957f3f4ef25a9d802b0bff9d3443df115ea074f7bc1dd1dd'],
  ['042_create_feedback_requests', '080183352fd99fc18a5444b5a0a5f0c19debb13f4b5be2aae7b2ada3bea1e170'],
  ['043_create_feedback_responses', 'b5f692e5da9e2df2c79453ab88327a5825a9d3a7bdb65338c2949ecacdb8c78a'],
  ['049_add_view_tokens_to_estimates_and_invoices', '2cfbad51283fb5c8bf2c0bea692ee3fdda766a859c919fd64884603b0e2f5dfc'],
  ['045_create_message_dispatches', 'c64e603e32d8ca4de671085ae49fac831cb677f8823ab6dc47c26e666d8ae98f'],
  ['048_create_assignments', 'c3380f1d6ae718c49b4cf0711fd5d906d17c26afa421fa7078c1f318f59b231e'],
  ['044_create_ai_artifacts', '0ee88beefaaa36212b6953d8dd2d149ce4a33568d8606aba103806e996d8ea4a'],
  ['046_estimate_view_expiry_and_acceptance', '91bdd015c4e60f666cbed2eff29d7b05713c129a636291543ece5ea630f7b83f'],
  ['047_invoice_view_expiry', '1dff2799ad6f049ee8e09f640ff0ea5ce78fe96d85e64251f442042591784ce2'],
  ['050_invoice_stripe_payment_link', '56befe2d46afc26bb4c6a1db7160fa451507f40b4b4aaf6ecaca70bfc33e24e7'],
  ['051_p8_entity_resolution_indexes', 'e41a353462c2e2e637ef6424bf5f61cf9d7b1abef6b4292a10252f049847c585'],
  ['052_p8_tenant_dnc_list', '602370affb74abfe76c2bd90fcb1a9c505b95bf44551c8150a1fae737dfb9163'],
  ['053_p8_customers_phone_index', '6ff49d22dd505991e96e5d5b14f9b0b682cf405020143c623e282d7ba8f1a648'],
  ['054_p8_telephony_tables', 'ae3ae54142d4910523868dc78c56b1893b9cede64efd59f5fc1eb38e3b0bf235'],
  ['056_create_service_agreements', '72fd99cd703625a935934946bcccb70a89fc29a94893cff6e439273e7ac49a05'],
  ['057_create_leads', '48fa6c5ea5ea2cac7098677433f6728772828da4419fa35eb4b244cba1bbfa78'],
  ['058_leads_phone_normalized', '38240cce920efcd577fdb8f48e86361933173e38c4d5df05d59e55c071cde6a4'],
  ['059_lead_attribution', 'aceb4349cb3e8bfd076c89fb1df2febd6e868ad136700cd710a5cb2bc359e8bf'],
  ['060_capture_schema', 'a38ff66341f8e24c68432c2a6a442d3181e1ee8e630d72357c9298b0815ae690'],
  ['061_create_lookup_events', '224eb9dea34c7bfcd92e5cfcdf63c8af3b60cdc693ec1036392ae4d146a00ae7'],
  ['062_create_knowledge_chunks', '047b45413e633e21dacadbb400c6830b556377829b761107d24da6bf080bd13d'],
  ['063_language_detection', '918c4cd778821e6b38a381c6dfceb3e3446c9e390245fcb6eca0e486067b576f'],
  ['064_create_job_photos', '3ad6f895d04b29e6ef6f1d2d5b74757b6417fe9e73cfe61e61ebe31b15dfd2a7'],
  ['065_create_portal_sessions', '6b939dc150298e5af212577fda04ec07aec8338f026a6107c7ad09491f1ded10'],
  ['066_create_voice_sessions_and_modes', '8268a58eecee1db168757965fe310b203a7bd9eb77b5b4fe2ed9e97d0bc94614'],
  ['067_create_time_entries', '069290a0144fb08de0171bb07d5255496236ef2d66a4dce40228a2de02c5a49f'],
  ['068_create_language_settings', 'dc485f4a1ec4e0bab7f3a58c6e54339d434057ceccbaa562c78952efa19e9931'],
  ['069_extend_leads_source_check', '12bbc1a8418385bed45dd66e9429700f82626b5f09c6752d195dac9cf87fdd84'],
  ['070_tenant_integrations', '2277f0362097114bd08cab63b070edb519916bb530777a37656777d2465ee930'],
  ['071_widen_tenant_integrations_status', '00d8a500f7bf1bc64bb1f8175ff63900ee3d15effddaec6fa3ec266dbe4f1600'],
  ['072_add_executing_status', 'cccb33af535e3d99643c7d0de588afb78fe39af2759132d9d126e9f4f022a357'],
  ['073_add_execution_retry_count', '061fc84a465b30151cd19619172d0dc5b3e01676272adada9488f4a635c09b22'],
  ['074_tenant_integrations_system_lookup', '3832dcf271a018e9a6d9d66c3ebba87c82ad3b910ff1e7debce83dbce870bd0d'],
  ['075_tenant_settings_quick_toggles', '66b5bde61e7778e6ac8f76e49097bff708ea5137ccdb52d0816496b2380bbcb6'],
  ['076_tenant_settings_auto_approve_threshold', 'f1bdefbaa0c21afb4f7ddf11e1c2f8da528ff38ed54fc97595f9a0425d7ade89'],
  ['077_tenant_settings_deposit_rules', 'a3a600e39f688c733850d6baec9e6aa163e730f999b00200cce8d0f7f5179163'],
  ['078_jobs_deposit_columns', '7346a842c870d8cc9333cc9fc5c5145931d5efe656e4aad98f9b189c0b18e78c'],
  ['079_tenant_settings_deposit_timing_policy', '7a175b9d0562783dfb7156e9ad9e5e999085f2a1c83ef3dc46c0ad23a233053a'],
  ['080_jobs_deposit_stripe_payment_link', 'aa8a9af29c34f9e94aaaf84f986ddf1e8c0ed1ea366346efe57fa833bfeb18a4'],
  ['081_jobs_deposit_credited_to_invoice', 'bf7f98ac752a53459c1cecf2a8bcae1eae925359f33b90efb81af10250af0b54'],
  ['082_create_pending_invitations', '89375ee7544ab33410c437964a8f0404ec9b2efadc8838fdf3d351852294bb4b'],
  ['083_tenants_stripe_subscription', 'e5bb319f522bd4fb26196092c9c6c869ab6d8d546d9316e57f67de765166ceee'],
  ['084_create_user_calendar_integrations', '3089d220b79db5759cf77d460dfc9e2b15910daf721627f56ad331af93450c80'],
  ['085_create_oauth_states', '32616c9ce0945fab815e7c4b2de968720a30c2533efdb3c53ce59d6332218c17'],
  ['086_create_appointment_calendar_events', '766a31919b81cb02372b34c5ba610b1fec70c800c6d56cf565cf99bc77ab5172'],
  ['087_tenants_stripe_connect', 'f3cf954e5fccbe1a3650b39dbcd5fd0dd8979ea1a1e909458f53791b23c5dd59'],
  ['088_fix_schema_constraints', '38dbe26a4e3d0389536214d8d4897f0d9e967d6ec8dc6e0638c849e0c9d38512'],
  ['089_drop_vertical_packs_type_check', 'dd41709b4300eb0ed03b2a477bdbe163440c76a557d5c07cdbe3e02910a803b8'],
  ['090_tenant_settings_voice_persona', '95805b86eb94d010c5c231ae4ab641e05debba20464a61888a42ac4809b0dcfb'],
  ['091_voice_session_outcome', '6fea1ddb8c3725191aff36013b7134fe7bf91af7392cc815da7f9c041fcfc59c'],
  ['092_extend_dispatch_entity_types', '151f56d737928f7fc0678c98d5a83bc0b7117bbbd9865cc770c2c46ad2ebbb94'],
  ['092_voice_session_transcript', 'f06ebad750ef6b1a8540d27aa14516f6db350b6debda0ec5cc444ad3a6e37f48'],
  ['093_users_deleted_at', '7d2ed611ca7751641c8cff049b55617e4af203b43257528e7c46c15bd80c127f'],
  ['094_add_held_appointment_fields', 'e71d08dc59d35a7c70c245572de551d7a4f48d4b7a5fcfd9164d39705a6f6607'],
  ['095_vertical_training_assets', '2c97e28a9f31bf562a69e4204779da6ed7a8aaf4f65ead102ce5c97a45156350'],
  ['096_create_expenses', '66dfd938628d33c4e65f25037c59d52fbed2848fa43123a94fb92f59b6d1a73e'],
  ['097_vertical_training_assets_idempotency', '3c0fbe088bd918a4900e6c1b3c6b68ace51959ff7ae3ecf2b09aae3285ed025a'],
  ['098_tenant_settings_onboarding_fields', 'cc5d352de051b7687fb2f379aa9dc247671aff5909f1a3a9d9c1f96af0830ad4'],
  ['099_proposal_executions_idempotency_index', '90549c0a15f7b54d35f70d02ee741b3c562eb9ed5d7119c4826e3ae36bf86f99'],
  ['100_payments_refund_tracking', '242a61a9e99abd1dfc793c6cd53962beeab7c15d283fa37d84004dfe1bf940ed'],
  ['101_google_reviews', 'ee39147f5eb59b0455ea40290a3592f70068907e13fa0d2c392ba4a3acd6d8f8'],
  ['102_review_poll_state', 'b069f6a315219c16ac432f1854b1865d337efa6a8fa66a12efc6c89d18ebb207'],
  ['103_service_credits', 'd4a6951eb9a1afe53bc92e1b81b7594e8f084d48765580ecae3065325198e102'],
  ['104_service_credits_review_fk', '3774d608685bc1c9fa21706ec1905be65a0fc9496c49aeac7b938422371ef97c'],
  ['105_create_dispatch_analytics', '4711390273626b42dccb496db8d9b355d5aa91d37dede77f9777ab14045c0c83'],
  ['106_tenant_settings_escalation_settings', '96affeb743beef4681931fb26f91441b50ddfe8139938028da862d9cefcd9ba0'],
  ['107_portal_sessions_system_lookup_rls', 'fd29a8fb3e536e27e307a1aa537e13bc4017525f8b08b2955d94078610da0eba'],
  ['108_tenant_settings_voice_agent_live', 'c030fc16ba92177b18589c7b3342ad945a0c6d2f0a59b0fa2449274d62b680e9'],
  ['109_users_mobile_number', '84773bb91c016828430bdb2f5a8504edef06193ad201ce41051a4b15134d9f22'],
  ['110_tenant_settings_brand_voice', '4d5499d20742415bb4852704a2fe3972446a3acc6efbfb050d4b57b573a6dc34'],
  ['111_phone_rate_limits', '07b4989a51fea21cf60c8f5245da2bab2ec01b8ebc4fae5afc8378545397594d'],
  ['112_dropped_call_recoveries', '40e7b282467a7da006b5b6ba0d9403eb6ab24ed7009332741c350517969e256f'],
  ['113_customer_vulnerability_fields', '464fc3086ad7b96cce4447abd1c65fe8048401de206a1c7aea95d0e92109f3d7'],
  ['114_weather_cache', 'df441501f3f1f009fb264ab67ff38048053d2fc9f999d99f40d494df6d011a16'],
  ['115_vulnerability_signals', 'c846d961b36ff8382fb829237c664d3b79443f14390d779263017e64632789d3'],
  ['116_tech_unavailable_blocks', '300d10f9639ca0bca5eabd9fa16831008afbbcf3c747f91a4f40c5929eab9fe0'],
  ['117_tech_status_today', '5f2224447036245f802ac7aeeb333fb46614670526fdc621285a4200d321a55a'],
  ['118_jobs_money_state', '2f7263cff926f33f21d8b01da9b01feb892c4f61ba09b8a1eafd404f455f8010'],
  ['119_view_token_lookup_functions', '0d4251c8391c2cdf6c1cb8120cf50e92c739e62db3a80cc8eaeb0b48579711a3'],
  ['120_tenant_settings_ai_config', 'e81e1e5ccef2b65ce8412ea57ccbca4b319a2ca67d9846ebc1c0ba871943a3b1'],
  ['121_estimate_revision_versioning', '9f1c9074e2f31c07b01e9a7f50989e89da5c198135017f8c31aa6906449d05c2'],
  ['122_estimate_reminders', '5f6c29e7825508f8e4a1d62e889fc93d5dfca96af26e9d0a1f8ae613a56d0cd2'],
  ['123_platform_deprovision_log', 'c05fefacd43c39abd95305589cc12404e46f2a3c2a85b556a7ecd15dae283e3a'],
  ['124_tenant_settings_review_urls', '889419f461a2e292ff89c910528927715eee23435bf69e74c4fac832fe8ef3b2'],
  ['125_dispatch_entity_en_route', '113fdf2a2aaba8da7250518612817363ffa77110f1d8c60ace32fcc255f55dc6'],
  ['125_estimates_deleted_at', '45ded6b32cd90fe40623332dafa7932ee33afbf6a8abb7df2afa117e04f72eec'],
  ['126_invoices_estimate_unique', 'b85be06a1ce1aa7d739ce2700e5a7fed6d08b757e6c58be92d136eea77846e44'],
  ['127_estimate_line_item_options', 'b6c373ef8aa306b24a1ea4c12f17fd5432446c00c3f1bd761050ff4dc7185ea5'],
  ['128_estimates_accepted_selection', 'bd49424960f39937bd085b19263e7fc7d7372275ac76d5cd5f004a44c395ca71'],
  ['129_estimates_one_accepted_per_job', '1267fa8e2704f3ef25a3f4c9ff981eb63b18d98bc0a2ffa6252e5ebe7165f8bd'],
  ['130_force_rls_missing_tables', '118b99fadd7df2d32568791a0976031e0893619e93e6c5ea199d937e28183c13'],
  ['131_appointment_assignments_no_double_booking', '27484d3c8eef021201ccd827419b3cbbec8516c14868759543b0f16d7ba3f295'],
  ['132_customer_consent_status', 'd4d2d0b5de1471a746cb9db7757630e27ef5a0f45e4fd61ad9c236645c49396d'],
  ['133_payments_reversal_tracking', '9e4be3033b999501b6faa258b4475d58452f322f797751b57f203529668f6afb'],
  ['134_proposal_chains', 'edcfadb2580167f35be75ea42d258fa7d499088d28cca5bbfc8b84823aa9e2ad'],
  ['135_appointments_idempotency_key', 'ab65a6bf7b64221c2761b81e7c5d6f42b2e048b7fa7fcb52ab4adffe1c370aeb'],
  ['136_create_invoice_dunning', '085bab2c52bb030111b677d061d70019eded0a144aa99797ac1eff80bfb3149a'],
  ['137_technician_working_hours', '9337884066ddee9644370bca78c50c7489a854a831ceec4e5cedfce8a707248d'],
  ['138_tenant_settings_auto_invoice_on_completion', '022db9a74cf4fab10dd8c23b6fabcbbf6edb36a7629adff7e39e5f05292e85f2'],
  ['139_create_invoice_schedules', '01debb27ace85e2ac1df38317894cce7b35fd54a20431fe526d12246fda696d9'],
  ['140_batch_invoicing', '63f7146c5a2b08ed910edff1f1f9136955d79474e796801239abb1ff96430fdc'],
  ['141_milestone_billing_safeguards', '38e660dbced93c8fa49efa7ddd4ae6e868c5cf10f3b1d5048dfed243e7d6c777'],
  ['142_proposals_source_recording_index', '2af70e5368d61c8338ac16f66557fd34c3a8daebc2d48b009d3bafa13514659d'],
  ['143_tenant_settings_owner_phone', 'af5c290ac32a8e6eb099212d29275aef11dff43f2a197a79865cbb7b8bc9c953'],
  ['144_tenants_pending_checkout_at', '93cb5302caca35e6587b01d97151e8424e554a6ec90c08274d67c81eb436f2b2'],
  ['145_tenants_pending_checkout_session_id', '2f4d5f3c8be0510bfbc1490192810d65358632d0bcc2540f116d77e5233eed36'],
  ['146_tenant_settings_activated_at', 'b1851a3b18b950f29de1e2df64e26e882a8096d4ef5916adb1bd127b5af12e34'],
  ['147_tenant_settings_vapi_assistant', '8e59538f846f9de4d53577e5fafbc0c3327b3e823c7907a2f6bc21290eae8a7a'],
  ['148_tenant_settings_business_profile_extras', '0b9f55aedb42e1a503aa1fc7338fa790a11be08d4bf3eca26cf205da582c9002'],
  ['149_tenant_settings_calendar_provider', '1ef4dcbef697bb3e060f0a3ba3102381631c053d0c696131623a63c6d0d03440'],
  ['150_tenant_settings_availability_template', 'c05e63c2025ecc6fd69cf4fdbee4ac447cda294f65f8e9efb77532c37cfe1175'],
];

function hashMigration(value: string): string {
  // Normalize line endings to LF before hashing so the snapshot is
  // stable across platforms — a Windows checkout with
  // `core.autocrlf=true` would otherwise read template-literal values
  // with `\r\n` and produce hashes that disagree with the snapshot
  // generated on Linux/macOS.
  const normalized = value.replace(/\r\n/g, '\n');
  return createHash('sha256').update(normalized).digest('hex');
}

const REGEN_HINT =
  "To regenerate the snapshot for an INTENTIONAL pre-deploy edit, run:\n" +
  "  npx tsx -e \"import { MIGRATIONS } from './packages/api/src/db/schema'; " +
  "import { createHash } from 'crypto'; " +
  "for (const [k, v] of Object.entries(MIGRATIONS)) " +
  "console.log('  [\"' + k + '\", \"' + createHash('sha256').update(v.replace(/\\r\\n/g, '\\n')).digest('hex') + '\"],');\"\n" +
  "and paste the output into test/db/migration-immutability.test.ts.";

describe('migrations are immutable once shipped', () => {
  it('every snapshotted migration matches the live MIGRATIONS value (no in-place mutation)', () => {
    const live = MIGRATIONS as Record<string, string>;
    const errors: string[] = [];

    for (const [key, expectedHash] of SNAPSHOT) {
      const value = live[key];
      if (value === undefined) {
        errors.push(
          `Migration "${key}" was REMOVED from MIGRATIONS. ` +
            'Production may have already run this migration; deletion would leave the runner ' +
            'unable to reproduce the schema. Restore the migration. If it really must go, ' +
            "do it via a follow-up migration that DROPs whatever the original CREATEd.",
        );
        continue;
      }
      const actualHash = hashMigration(value);
      if (actualHash !== expectedHash) {
        errors.push(
          `Migration "${key}" was MUTATED IN PLACE.\n` +
            '  Production may have already run this value; CREATE TABLE IF NOT EXISTS is a ' +
            'no-op against existing tables, so any column added here would be silently ' +
            'skipped and any index referencing it would crash startup.\n' +
            '  See PR #225 / 058_leads_phone_normalized for the correct pattern: revert this ' +
            "migration's value and add a NEW migration with idempotent ALTER / CREATE INDEX " +
            'IF NOT EXISTS.\n' +
            `  ${REGEN_HINT}`,
        );
      }
    }

    expect(errors, errors.join('\n\n')).toEqual([]);
  });

  it('every live migration is in the snapshot (forces deliberate update for new migrations)', () => {
    const snapshotKeys = new Set(SNAPSHOT.map(([k]) => k));
    const live = Object.keys(MIGRATIONS);
    const missing = live.filter((k) => !snapshotKeys.has(k));

    expect(
      missing,
      `Migrations added without a snapshot entry: ${missing.join(', ')}.\n` +
        'New migrations must be locked into the immutability snapshot before merge so ' +
        'subsequent in-place mutations get caught.\n' +
        REGEN_HINT,
    ).toEqual([]);
  });

  it('snapshot has no duplicate keys', () => {
    const seen = new Set<string>();
    const dups: string[] = [];
    for (const [k] of SNAPSHOT) {
      if (seen.has(k)) dups.push(k);
      seen.add(k);
    }
    expect(dups).toEqual([]);
  });
});
