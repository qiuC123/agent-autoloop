// ASCII batch files preserve Unicode paths without changing the user's console code page.
export function windowsLauncher(node: string, program: string) {
  const encoded = (value: string) => `Buffer.from('${Buffer.from(value).toString("base64")}','base64').toString()`;
  const script = `const{spawnSync}=require('node:child_process');const r=spawnSync(${encoded(node)},['--disable-warning=ExperimentalWarning',${encoded(program)},...process.argv.slice(1)],{stdio:'inherit'});if(r.error)console.error(r.error.message);process.exit(r.status??1)`;
  return `@echo off\r\nsetlocal DisableDelayedExpansion\r\nnode.exe -e "${script}" -- %*\r\n`;
}

if (import.meta.main) {
  console.log(Buffer.from(windowsLauncher(process.argv[2], process.argv[3]), "ascii").toString("base64"));
}
