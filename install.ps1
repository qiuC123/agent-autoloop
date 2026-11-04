# Installs the same source checkout as install.sh, using the current user's token and no global packages.
$ErrorActionPreference = 'Stop'
$initArgs = @($args)
$repo = if ($env:AGENT_AUTOLOOP_REPO) { $env:AGENT_AUTOLOOP_REPO } else { 'https://github.com/KKKKhazix/agent-autoloop.git' }
$dataRoot = if ($env:AGENT_AUTOLOOP_HOME) { [IO.Path]::GetFullPath($env:AGENT_AUTOLOOP_HOME) } else { Join-Path $env:USERPROFILE '.agent-autoloop' }
$app = Join-Path $dataRoot 'app'
$program = Join-Path $app 'bin/agent-autoloop.ts'
$git = Get-Command git.exe -ErrorAction SilentlyContinue
if (-not $git) { throw '需要 Git for Windows。装好后重新打开终端再安装。' }
$node = Get-Command node.exe -ErrorAction SilentlyContinue
if (-not $node) { throw '需要 Node.js 24 或更新。请从 https://nodejs.org 安装后重新打开终端。' }
& $node.Path -e 'process.exit(parseInt(process.versions.node, 10) >= 24 ? 0 : 1)'
if ($LASTEXITCODE -ne 0) { throw '需要 Node.js 24 或更新。请升级后重新打开终端。' }

New-Item -ItemType Directory -Path $dataRoot -Force | Out-Null
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
$acl = New-Object Security.AccessControl.DirectorySecurity
$acl.SetAccessRuleProtection($true, $false)
$acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')))
[IO.Directory]::SetAccessControl($dataRoot, $acl)

if (Test-Path -LiteralPath (Join-Path $app '.git')) {
    & $git.Path -C $app pull --ff-only --quiet
} else {
    & $git.Path clone --quiet --depth 1 -- $repo $app
}
if ($LASTEXITCODE -ne 0) { throw '下载或更新代码失败，原配置没有改动。' }

# A .cmd launcher is installed only in an existing PATH directory and only over our own exact launcher.
$launcherBytes = & $node.Path (Join-Path $app 'host/windows-launcher.ts') $node.Path $program
if ($LASTEXITCODE -ne 0) { throw '创建命令入口失败。' }
$launcher = [Text.Encoding]::ASCII.GetString([Convert]::FromBase64String($launcherBytes))
$command = $null
$localBin = Join-Path $env:USERPROFILE '.local/bin'
$places = @($localBin) + @($env:PATH -split ';')
foreach ($place in ($places | Select-Object -Unique)) {
    if (-not $place -or -not [IO.Path]::IsPathRooted($place)) { continue }
    if (-not (@($env:PATH -split ';') -contains $place)) { continue }
    if ($place -eq $localBin) { New-Item -ItemType Directory -Path $place -Force | Out-Null }
    if (-not (Test-Path -LiteralPath $place -PathType Container)) { continue }
    $target = Join-Path $place 'agent-autoloop.cmd'
    if (Test-Path -LiteralPath $target) {
        if ([IO.File]::GetAttributes($target) -band [IO.FileAttributes]::ReparsePoint) { continue }
        if ([IO.File]::ReadAllText($target) -ne $launcher) { continue }
    }
    try {
        [IO.File]::WriteAllText($target, $launcher, (New-Object Text.UTF8Encoding($false)))
        $command = $target
        break
    } catch [UnauthorizedAccessException] { continue } catch [IO.IOException] { continue }
}

$env:AGENT_AUTOLOOP_HOME = $dataRoot
if (Test-Path -LiteralPath (Join-Path $dataRoot 'config.json')) {
    Write-Output '更新好了。'
    if ($initArgs -notcontains '--no-service') { & $node.Path --disable-warning=ExperimentalWarning $program service install }
} else {
    & $node.Path --disable-warning=ExperimentalWarning $program init @initArgs
}
if ($LASTEXITCODE -ne 0) { throw '程序配置失败，请查看上面的提示。' }
if (-not $command -or (Get-Command agent-autoloop -ErrorAction SilentlyContinue).Source -ne $command) {
    $quotedNode = "'" + $node.Path.Replace("'", "''") + "'"
    $quotedProgram = "'" + $program.Replace("'", "''") + "'"
    Write-Output "在 PowerShell 中使用：& $quotedNode $quotedProgram status"
}
