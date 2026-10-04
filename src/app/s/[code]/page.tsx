import { SessionApp } from '@/components/session/SessionApp';

export const dynamic = 'force-dynamic';

export default async function SessionPage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  return <SessionApp code={code.toUpperCase().slice(0, 12)} />;
}
