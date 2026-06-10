import { NextResponse } from 'next/server';
import {
  apiCustomerToMobile,
  mobilePatchBodyToApi,
  type ApiCustomerJson,
} from '@/lib/customer-api-adapters';
import { serviceOsFetch } from '@/lib/service-os-api-client';

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const res = await serviceOsFetch(`/api/customers/${encodeURIComponent(id)}`);
  if (!res.ok) {
    const body = await res.text();
    return new NextResponse(body, { status: res.status, headers: { 'Content-Type': 'application/json' } });
  }
  const data = (await res.json()) as ApiCustomerJson;
  return NextResponse.json(apiCustomerToMobile(data));
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.json();
  const { name, phone, email, address } = body as Record<string, string | undefined>;

  const payload = mobilePatchBodyToApi({
    name,
    phone,
    email,
    address,
  });

  const res = await serviceOsFetch(`/api/customers/${encodeURIComponent(id)}`, {
    method: 'PUT',
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const errBody = await res.text();
    return new NextResponse(errBody, { status: res.status, headers: { 'Content-Type': 'application/json' } });
  }

  const updated = (await res.json()) as ApiCustomerJson;
  return NextResponse.json(apiCustomerToMobile(updated));
}
