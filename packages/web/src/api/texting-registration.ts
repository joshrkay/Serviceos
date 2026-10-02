/**
 * #1564 — client for the owner-only US A2P 10DLC texting registration
 * (GET/PUT /api/settings/texting-registration). The EIN is sent once on
 * submit and never comes back — reads return only its last four digits.
 */
import { apiFetch } from '../utils/api-fetch';

export type TextingRegistrationStatus =
  | 'not_started'
  | 'submitted'
  | 'brand_pending'
  | 'campaign_pending'
  | 'approved'
  | 'failed';

export const BUSINESS_TYPES = [
  'Limited Liability Corporation',
  'Corporation',
  'Partnership',
  'Co-operative',
  'Non-profit Corporation',
] as const;

export const JOB_POSITIONS = ['CEO', 'GM', 'Director', 'VP', 'CFO', 'General Counsel', 'Other'] as const;

export interface TextingRegistrationAddress {
  street: string;
  street2: string | null;
  city: string;
  region: string;
  postalCode: string;
}

export interface TextingRegistrationContact {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  title: string;
  jobPosition: string;
}

export interface TextingRegistrationView {
  status: TextingRegistrationStatus;
  readiness: 'partial_readiness' | 'full_readiness';
  details: {
    legalBusinessName: string;
    einLast4: string;
    businessType: string;
    businessIndustry: string;
    websiteUrl: string | null;
    address: TextingRegistrationAddress;
    contact: TextingRegistrationContact;
  } | null;
  failureReasons: string[];
  submittedAt: string | null;
  approvedAt: string | null;
  updatedAt: string | null;
}

export interface TextingRegistrationSubmission {
  legalBusinessName: string;
  ein: string;
  businessType: string;
  businessIndustry: string;
  websiteUrl: string;
  address: { street: string; street2: string; city: string; region: string; postalCode: string };
  contact: TextingRegistrationContact;
}

export class TextingRegistrationError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly fields: Array<{ path: string; message: string }> = [],
  ) {
    super(message);
    this.name = 'TextingRegistrationError';
  }
}

async function toError(res: Response, fallback: string): Promise<TextingRegistrationError> {
  let body: { message?: string; fields?: Array<{ path: string; message: string }> } = {};
  try {
    body = await res.json();
  } catch {
    // non-JSON error body
  }
  return new TextingRegistrationError(res.status, body.message ?? fallback, body.fields ?? []);
}

export async function fetchTextingRegistration(): Promise<TextingRegistrationView> {
  const res = await apiFetch('/api/settings/texting-registration');
  if (!res.ok) throw await toError(res, `Could not load texting registration (${res.status})`);
  return res.json();
}

export async function submitTextingRegistration(
  submission: TextingRegistrationSubmission,
): Promise<TextingRegistrationView> {
  const res = await apiFetch('/api/settings/texting-registration', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(submission),
  });
  if (!res.ok) throw await toError(res, `Could not submit texting registration (${res.status})`);
  return res.json();
}
