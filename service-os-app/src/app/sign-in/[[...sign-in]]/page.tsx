import { SignIn } from '@clerk/nextjs';

export default function SignInPage() {
  return (
    <div className="min-h-dvh flex items-center justify-center bg-slate-50 p-4">
      <SignIn
        appearance={{
          elements: {
            rootBox: 'w-full max-w-sm',
            card: 'shadow-lg',
          },
        }}
      />
    </div>
  );
}
