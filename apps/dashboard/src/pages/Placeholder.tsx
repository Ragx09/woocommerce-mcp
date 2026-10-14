export function Placeholder({ title, task }: { title: string; task?: string }) {
  return (
    <section>
      <h1>{title}</h1>
      <p className="muted">{task ? `This page arrives with ${task}.` : 'There is no page at this address.'}</p>
    </section>
  );
}
