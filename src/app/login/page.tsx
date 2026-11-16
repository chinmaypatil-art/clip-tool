import { Suspense } from "react";
import { Scissors } from "lucide-react";

async function WrongPassword({ searchParams }: { searchParams: Promise<{ wrong?: string }> }) {
  const { wrong } = await searchParams;
  return wrong ? <p className="text-center text-xs text-red-400">Wrong password.</p> : null;
}

export default function LoginPage({ searchParams }: { searchParams: Promise<{ wrong?: string }> }) {
  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <form method="POST" action="/api/login" className="w-full max-w-xs space-y-4">
        <div className="flex items-center justify-center gap-2 pb-2 text-white">
          <Scissors size={18} />
          <span className="text-lg font-semibold tracking-tight">Clipwise</span>
        </div>
        <input
          type="password"
          name="password"
          autoFocus
          required
          placeholder="Password"
          className="w-full rounded-xl border border-white/10 bg-zinc-900 px-4 py-2.5 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-white/30 focus:outline-none"
        />
        <Suspense>
          <WrongPassword searchParams={searchParams} />
        </Suspense>
        <button className="w-full rounded-xl bg-white py-2.5 text-sm font-medium text-zinc-900 transition hover:bg-zinc-200">
          Enter
        </button>
      </form>
    </main>
  );
}
