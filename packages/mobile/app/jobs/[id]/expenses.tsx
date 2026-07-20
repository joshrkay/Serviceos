import { useLocalSearchParams, useRouter } from 'expo-router';
import { Pressable, Text, View } from 'react-native';
import { ScreenShell } from '../../../src/components/ScreenShell';

// D2 — expense / materials logging on a job.
//
// Open Question 6 resolution: there is NO direct client-reachable expense-write
// route, and the POST /api/proposals mint whitelist admits only the four
// scheduling types (routes/proposals.ts) — `log_expense` is deliberately absent.
// Server-side, every expense today is written through an APPROVED `log_expense`
// proposal (proposals/execution/log-expense-handler.ts), and there is no
// `expenses:*` RBAC permission for an un-gated write. Minting an expense from
// the client, or adding the first un-approved expense-write route, would both
// cross a real authorization boundary — so per the unit's guidance we DEFER
// rather than invent a route here. This mirrors the shipped U5 late-fee pattern
// (app/invoices/[id].tsx): surface the sanctioned voice affordance so the owner
// still has a path, and the capture lands in Approvals for confirmation.
export default function JobExpenses() {
  const params = useLocalSearchParams<{ id: string }>();
  const id = Array.isArray(params.id) ? params.id[0] : (params.id ?? '');
  const router = useRouter();

  return (
    <ScreenShell title="Log an expense" backLabel="‹ Job">
      <Text className="mb-4 text-base text-mutedForeground">
        To log materials or an expense on this job, say it out loud — for example
        “eighty dollars of fittings from the supply house.” It lands in Approvals
        for you to confirm before anything is recorded.
      </Text>
      <Text className="mb-6 text-sm text-mutedForeground">
        Amounts are captured to the cent and tagged to this job, so they show up
        in the job’s costs.
      </Text>
      <View className="gap-4">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Log an expense by voice"
          disabled={!id}
          onPress={() => router.push({ pathname: '/voice', params: { jobId: id } })}
          className={`min-h-11 items-center justify-center rounded-md bg-primary px-4 py-3 ${
            id ? '' : 'opacity-50'
          }`}
        >
          <Text className="text-base font-semibold text-primaryForeground">
            Log by voice
          </Text>
        </Pressable>
      </View>
    </ScreenShell>
  );
}
