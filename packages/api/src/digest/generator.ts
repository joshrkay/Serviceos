/**
 * P5-020 — End-of-day digest text generator.
 */
import type { Proposal } from '../proposals/proposal';
import { deriveMarkersFromProposal } from '../proposals/markers/render';
import type { DigestSections } from '@ai-service-os/shared';

export interface DigestDayStats {
  jobsCompleted: number;
  invoicedCents: number;
  collectedCents: number;
  quotesSent: number;
  quotesValueCents: number;
  followUpsSent: number;
  tomorrowAppointmentCount: number;
  tomorrowFirst?: string;
  tomorrowLast?: string;
}

export interface BuildDigestInput {
  businessName: string;
  localDate: string;
  stats: DigestDayStats;
  markerProposals: Proposal[];
  lessons: string[];
}

function money(cents: number): string {
  return `$${(cents / 100).toFixed(0)}`;
}

export function buildDigestSections(input: BuildDigestInput): DigestSections {
  const s = input.stats;
  const sections: DigestSections = {
    today: `Today: ${s.jobsCompleted} jobs done, ${money(s.invoicedCents)} invoiced, ${money(s.collectedCents)} collected.`,
    pipeline: `Pipeline: ${s.quotesSent} quotes (${money(s.quotesValueCents)}).`,
    followUps: `Follow-ups: ${s.followUpsSent} invoice nudges sent.`,
    tomorrow:
      s.tomorrowAppointmentCount > 0
        ? `Tomorrow: ${s.tomorrowAppointmentCount} appts${s.tomorrowFirst ? `, ${s.tomorrowFirst}–${s.tomorrowLast ?? s.tomorrowFirst}` : ''}.`
        : 'Tomorrow: clear schedule.',
  };

  const uncertain = input.markerProposals
    .map((p) => {
      const markers = deriveMarkersFromProposal(p);
      if (markers.length === 0) return null;
      return `${p.summary}: ${markers.map((m) => m.explanation).join('; ')}`;
    })
    .filter((line): line is string => Boolean(line));

  if (uncertain.length > 0) {
    sections.uncertain = `Not sure: ${uncertain.slice(0, 3).join(' | ')}`;
  }

  if (input.lessons.length > 0) {
    sections.learned = `Learned: ${input.lessons.slice(0, 3).join(' | ')}`;
  }

  return sections;
}

export function renderDigestSms(sections: DigestSections, businessName: string): string {
  const parts = [
    `${businessName} digest`,
    sections.today,
    sections.pipeline,
    sections.followUps,
    sections.tomorrow,
    sections.uncertain,
    sections.learned,
    'Reply LOOKS GOOD or tell me what to fix.',
  ].filter((p): p is string => Boolean(p));
  const body = parts.join('\n');
  return body.length > 320 ? `${body.slice(0, 317)}…` : body;
}
