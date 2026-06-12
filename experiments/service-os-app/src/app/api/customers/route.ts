import { NextResponse } from 'next/server';
import {
  apiCustomerToMobile,
  mobileCreateBodyToApi,
  type ApiCustomerJson,
} from '@/lib/customer-api-adapters';
import { serviceOsFetch } from '@/lib/service-os-api-client';

export async function GET() {
  const res = await serviceOsFetch('/api/customers');
  if (!res.ok) {
    const body = await res.text();
    return new NextResponse(body, { status: res.status, headers: { 'Content-Type': 'application/json' } });
  }
  const data = (await res.json()) as ApiCustomerJson[];
  const mapped = Array.isArray(data) ? data.map(apiCustomerToMobile) : [];
  return NextResponse.json(mapped);
}

export async function POST(req: Request) {
  const body = await req.json();
  const { name, phone, email, address } = body as Record<string, string | undefined>;

  if (!name || typeof name !== 'string' || !name.trim()) {
    return NextResponse.json({ error: 'Name is required' }, { status: 400 });
  }

  const payload = mobileCreateBodyToApi({
    name: name.trim(),
    phone: phone?.trim(),
    email: email?.trim(),
    address: address?.trim(),
  });

  const res = await serviceOsFetch('/api/customers', {
    method: 'POST',
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const errBody = await res.text();
    return new NextResponse(errBody, { status: res.status, headers: { 'Content-Type': 'application/json' } });
  }

  const created = (await res.json()) as ApiCustomerJson;
  return NextResponse.json(apiCustomerToMobile(created), { status: 201 });
}
