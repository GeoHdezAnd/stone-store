export function StatusTag({
  active,
  activeLabel,
  inactiveLabel,
}: {
  active: boolean;
  activeLabel: string;
  inactiveLabel: string;
}) {
  return (
    <span className={active ? 'tag tag-ink' : 'tag tag-outline'}>
      {active ? activeLabel : inactiveLabel}
    </span>
  );
}
