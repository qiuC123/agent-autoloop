// ASCII batch files preserve Unicode paths without changing the user's console code page.
export function windowsLauncher(node: string, program: string) {
  const encoded = (value: string) => `Buffer.from('${Buffer.from(value).toString("base64")}','base64').toString()`;
  const script = `const{spawn}=require('node:child_process');const r=spawn(${encoded(node)},['--disable-warning=ExperimentalWarning',${encoded(program)},...process.argv.slice(1)],{stdio:'inherit'});r.on('error',e=>{console.error(e.message);process.exitCode=1});r.on('exit',code=>{process.exitCode=code??1})`;
  return `@echo off\r\nsetlocal DisableDelayedExpansion\r\nnode.exe -e "${script}" -- %*\r\n`;
}

if (import.meta.main) {
  console.log(Buffer.from(windowsLauncher(process.argv[2], process.argv[3]), "ascii").toString("base64"));
}
