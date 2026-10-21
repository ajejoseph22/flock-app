export function Prose({ title, updated, children }: { title: string; updated?: string; children: React.ReactNode }) {
  return (
    <article className="mx-auto max-w-3xl px-4 py-16 sm:px-6">
      <h1 className="text-3xl font-display font-bold tracking-[-0.025em]">{title}</h1>
      {updated && <p className="mt-2 text-sm text-muted-foreground">Last updated {updated}</p>}
      <div className="mt-8 flex flex-col gap-4 leading-relaxed text-muted-foreground [&_a]:text-accent [&_a]:underline [&_h2]:mt-6 [&_h2]:text-lg [&_h2]:font-semibold [&_h2]:text-foreground [&_li]:ml-5 [&_li]:list-disc [&_strong]:text-foreground">
        {children}
      </div>
    </article>
  );
}
