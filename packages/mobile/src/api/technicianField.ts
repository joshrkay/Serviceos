import type {
  EnRouteNoticeRequest,
  EnRouteNoticeResponse,
  RunningLateRequest,
  RunningLateResponse,
  TechnicianDayAppointmentListResponse,
  TechnicianLocationPingBatchRequest,
  TechnicianLocationPingBatchResponse,
  TechnicianLocationPingInput,
} from '@ai-service-os/shared';
import type { AuthedFetch } from './me';

export type TechnicianLocationPing = TechnicianLocationPingInput;

export type TechnicianLocationBatchInput = TechnicianLocationPingBatchRequest;

const JSON_HEADERS = { 'Content-Type': 'application/json' };

async function throwResponseError(operation: string, response: Response): Promise<never> {
  let detail = '';
  try {
    const body = (await response.json()) as { message?: string };
    detail = typeof body.message === 'string' ? body.message : '';
  } catch {
    detail = '';
  }
  throw new Error(
    `${operation}: ${response.status} ${response.statusText}${detail ? ` — ${detail}` : ''}`,
  );
}

export async function listTechnicianAppointments(
  client: AuthedFetch,
  technicianId: string,
  tenantLocalDate: string,
): Promise<TechnicianDayAppointmentListResponse> {
  const path =
    `/api/dispatch/technician/${encodeURIComponent(technicianId)}/appointments` +
    `?date=${encodeURIComponent(tenantLocalDate)}`;
  const response = await client(path);
  if (!response.ok) await throwResponseError('listTechnicianAppointments', response);
  return (await response.json()) as TechnicianDayAppointmentListResponse;
}

export async function postEnRoute(
  client: AuthedFetch,
  appointmentId: string,
  request: EnRouteNoticeRequest = {},
): Promise<EnRouteNoticeResponse> {
  const response = await client(
    `/api/dispatch/appointments/${encodeURIComponent(appointmentId)}/en-route`,
    {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify(request),
    },
  );
  if (!response.ok) await throwResponseError('postEnRoute', response);
  return (await response.json()) as EnRouteNoticeResponse;
}

export async function postRunningLate(
  client: AuthedFetch,
  appointmentId: string,
  delayMinutes = 20,
): Promise<RunningLateResponse> {
  const request: RunningLateRequest = { delayMinutes };
  const response = await client(
    `/api/appointments/${encodeURIComponent(appointmentId)}/running-late`,
    {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify(request),
    },
  );
  if (!response.ok) await throwResponseError('postRunningLate', response);
  return (await response.json()) as RunningLateResponse;
}

export async function postLocationBatch(
  client: AuthedFetch,
  request: TechnicianLocationBatchInput,
): Promise<TechnicianLocationPingBatchResponse> {
  const response = await client('/api/technician-location', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify(request),
  });
  if (!response.ok) await throwResponseError('postLocationBatch', response);
  return (await response.json()) as TechnicianLocationPingBatchResponse;
}
