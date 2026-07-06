export interface HeaderProps {
  title: string;
}

export function Header({ title }: HeaderProps) {
  return (
    <header className="app-header">
      <h1>{title}</h1>
      <nav>
        <a href="#/">Home</a>
        <a href="#/search">Find a sailing</a>
      </nav>
    </header>
  );
}
