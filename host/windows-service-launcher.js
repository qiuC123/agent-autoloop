// Windows Script Host JScript: hide the console and keep Task Scheduler attached until Node exits.
var args = [];
for (var i = 0; i < WScript.Arguments.Count(); i++) {
  args.push('"' + WScript.Arguments(i).replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, "$1$1") + '"');
}
WScript.Quit(new ActiveXObject("WScript.Shell").Run(args.join(" "), 0, true));
