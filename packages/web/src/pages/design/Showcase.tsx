import React, { useState } from 'react';
import { Plus, Search, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
  Field,
  Input,
  Select,
  Skeleton,
  SkeletonText,
  Spinner,
  Textarea,
  type BadgeVariant,
  type ButtonVariant,
} from '../../components/ui';

const BUTTON_VARIANTS: ButtonVariant[] = [
  'primary',
  'secondary',
  'outline',
  'ghost',
  'danger',
];

const BADGE_VARIANTS: BadgeVariant[] = [
  'neutral',
  'primary',
  'success',
  'warning',
  'danger',
  'info',
];

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-3">
      <div>
        <h2 className="text-slate-900">{title}</h2>
        {description && (
          <p className="text-sm text-slate-400">{description}</p>
        )}
      </div>
      <Card>
        <CardContent className="flex flex-col gap-4 py-5">
          {children}
        </CardContent>
      </Card>
    </section>
  );
}

/**
 * Living style guide for the Fieldly design system. Mounted at `/design`
 * so the team can see every primitive, variant, and state in one place
 * while adoption rolls out across the app.
 */
export function Showcase() {
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  return (
    <div className="h-full overflow-y-auto pb-20 md:pb-6">
      <div className="mx-auto flex max-w-3xl flex-col gap-8 px-4 md:px-6 pt-5">
        <header>
          <h1 className="text-slate-900">Design system</h1>
          <p className="mt-1 text-sm text-slate-400">
            Fieldly UI primitives — token-driven, dependency-free building
            blocks. Import from{' '}
            <code className="rounded bg-slate-100 px-1 py-0.5 text-xs">
              components/ui
            </code>
            .
          </p>
        </header>

        <Section
          title="Buttons"
          description="Variants, sizes, icons, loading and disabled states."
        >
          <div className="flex flex-wrap items-center gap-2">
            {BUTTON_VARIANTS.map((v) => (
              <Button key={v} variant={v}>
                {v}
              </Button>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm">Small</Button>
            <Button size="md">Medium</Button>
            <Button size="lg">Large</Button>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button leftIcon={<Plus size={14} />}>New customer</Button>
            <Button variant="outline" leftIcon={<Search size={14} />}>
              Search
            </Button>
            <Button variant="danger" leftIcon={<Trash2 size={14} />}>
              Delete
            </Button>
            <Button loading>Saving</Button>
            <Button disabled>Disabled</Button>
          </div>
        </Section>

        <Section
          title="Form controls"
          description="Inputs, selects, and textareas wired through Field for labels and errors."
        >
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <Field label="Full name" required>
              <Input placeholder="Jane Doe" />
            </Field>
            <Field label="Email" hint="We'll never share it.">
              <Input type="email" placeholder="jane@example.com" />
            </Field>
            <Field label="Service type">
              <Select defaultValue="">
                <option value="">Select…</option>
                <option value="hvac">HVAC</option>
                <option value="plumbing">Plumbing</option>
                <option value="painting">Painting</option>
              </Select>
            </Field>
            <Field
              label="Phone"
              error="Enter a valid phone number"
            >
              <Input defaultValue="abc" />
            </Field>
            <Field label="Notes" className="md:col-span-2">
              <Textarea placeholder="Access notes, gate codes…" />
            </Field>
          </div>
          <div>
            <Input leftIcon={<Search size={14} />} placeholder="Search…" />
          </div>
        </Section>

        <Section title="Badges" description="Status pills and tags.">
          <div className="flex flex-wrap items-center gap-2">
            {BADGE_VARIANTS.map((v) => (
              <Badge key={v} variant={v}>
                {v}
              </Badge>
            ))}
          </div>
        </Section>

        <Section
          title="Cards"
          description="The standard surface container, with header/content/footer."
        >
          <Card>
            <CardHeader>
              <CardTitle>Acme HVAC</CardTitle>
              <Badge variant="info">2 locations</Badge>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-slate-600">
                123 Main St · Austin, TX 78701
              </p>
            </CardContent>
            <CardFooter>
              <Button size="sm" variant="outline">
                View
              </Button>
              <Button size="sm">New job</Button>
            </CardFooter>
          </Card>
        </Section>

        <Section
          title="Loading & feedback"
          description="Spinners, skeletons, and toasts."
        >
          <div className="flex items-center gap-4">
            <Spinner size="sm" className="text-slate-400" />
            <Spinner size="md" className="text-slate-400" />
            <Spinner size="lg" className="text-slate-400" />
          </div>
          <div className="flex flex-col gap-2">
            <Skeleton className="h-4 w-48" />
            <SkeletonText lines={3} />
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => toast.success('Saved successfully')}
            >
              Success toast
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => toast.error('Something went wrong')}
            >
              Error toast
            </Button>
          </div>
        </Section>

        <Section
          title="Empty / error / loading states"
          description="Toggle the shared list/detail states."
        >
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              loading={loading}
              onClick={() => {
                setLoading(true);
                setTimeout(() => setLoading(false), 1500);
              }}
            >
              Simulate loading
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setError(error ? null : 'Demo error message')}
            >
              {error ? 'Clear error' : 'Trigger error'}
            </Button>
          </div>
          {error && (
            <p role="alert" className="text-sm text-red-600">
              {error}
            </p>
          )}
        </Section>
      </div>
    </div>
  );
}
