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
  ['070_tenant_location_and_integrations', '52c828957502021bf5430f1fb19cf3f3608cb99673a9f9439f3e30ab001dca0f'],
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
  // Phase-13 voice_sessions + per-user current_mode + tenant-level
  // backup-supervisor / unsupervised routing. Body byte-identical to
  // the original 063_create_voice_sessions_and_modes entry from the
  // p12-mode-switching branch; key bumped to 066 on merge because
  // main claimed 063–065 first.
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
