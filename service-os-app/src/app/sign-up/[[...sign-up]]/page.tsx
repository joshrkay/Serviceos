import { SignUp } from '@clerk/nextjs';

export default function SignUpPage() {
  return (
    <div className="min-h-dvh flex items-center justify-center bg-slate-50 p-4">
      <SignUp
        appearance={{
          elements: {
            rootBox: 'w-full max-w-sm',
            card: 'shadow-lg',
          },
        }}
        unsafeMetadata={{
          business_name: '',
          trade_type: 'hvac',
        }}
      />
    </div>
  );
}
