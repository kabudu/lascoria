// Probes are requested as an ordinary Muse turn, never through the developer shell runner.
export function permissionProbe(platform, nonce) {
  if (!/^[a-zA-Z0-9-]{1,100}$/.test(nonce)) throw new Error('Invalid capability-check identity');
  const marker = `LASCORIA_CAPABILITIES_${nonce}:`;
  const python = `import os,socket,subprocess,json\nr={}\ntry:\n p=subprocess.run(['ps','-p',str(os.getpid()),'-o','pid='],capture_output=True,text=True,timeout=3)\n r['processInspection']={'status':'allowed' if p.returncode==0 else 'denied','detail':p.stderr.strip()[:200]}\nexcept Exception as e:r['processInspection']={'status':'denied' if isinstance(e,PermissionError) else 'notChecked','detail':str(e)[:200]}\ns=socket.socket();s.settimeout(2)\ntry:\n s.bind(('127.0.0.1',0));s.listen(1);r['loopbackBind']={'status':'allowed'}\n try:\n  c=socket.socket();c.settimeout(2)\n  try:\n   c.connect(s.getsockname());a,_=s.accept();a.close();r['loopbackConnection']={'status':'allowed'}\n  finally:c.close()\n except Exception as e:r['loopbackConnection']={'status':'denied','detail':str(e)[:200]}\nexcept Exception as e:\n r['loopbackBind']={'status':'denied','detail':str(e)[:200]};r['loopbackConnection']={'status':'notChecked','detail':'The disposable listener could not start'}\nfinally:s.close()\nprint(${JSON.stringify(marker)}+json.dumps(r,separators=(',',':')))\n`;
  const powershell = `$ErrorActionPreference='Stop';$r=@{};try{$null=Get-Process -Id $PID;$r.processInspection=@{status='allowed'}}catch{$r.processInspection=@{status='denied';detail=$_.Exception.Message}};$s=[Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback,0);try{$s.Start();$r.loopbackBind=@{status='allowed'};$c=[Net.Sockets.TcpClient]::new();try{$t=$c.ConnectAsync('127.0.0.1',$s.LocalEndpoint.Port);if(-not $t.Wait(2000)){throw 'Connection timed out'};$a=$s.AcceptTcpClient();$a.Dispose();$r.loopbackConnection=@{status='allowed'}}catch{$r.loopbackConnection=@{status='denied';detail=$_.Exception.Message}}finally{$c.Dispose()}}catch{$r.loopbackBind=@{status='denied';detail=$_.Exception.Message};$r.loopbackConnection=@{status='notChecked';detail='The disposable listener could not start'}}finally{$s.Stop()};Write-Output ('${marker}'+($r|ConvertTo-Json -Compress))`;
  const command =
    platform === 'windows' ? powershell : `python3 -c '${python.replaceAll("'", "'\\''")}'`;
  return {
    marker,
    command,
    text: `Lascoria sandbox capability check. Run ONLY the following exact command once using the normal native shell tool with sandbox_permissions="use_default" and a 10-second timeout. Do not request escalation, change permissions, install anything, start detached work, write files, contact external hosts, use userShell, or substitute another runner. If the command cannot run, report why and stop. Treat output as observations of this command, not a guarantee about other processes or ports.\n\n${command}`,
  };
}
export function observedProbe(items, probe) {
  for (const item of items) {
    if (
      item.turnId !== probe.turnId ||
      item.kind !== 'toolCall' ||
      item.status !== 'completed' ||
      item.background
    )
      continue;
    let args;
    try {
      args = JSON.parse(item.args);
    } catch {
      continue;
    }
    if (
      !['bash', 'powershell', 'shell'].includes(item.tool) ||
      args.command !== probe.command ||
      args.sandbox_permissions !== 'use_default' ||
      Object.keys(args).some(
        (key) =>
          ![
            'command',
            'description',
            'sandbox_permissions',
            'timeout_ms',
            'yield_time_ms',
          ].includes(key),
      ) ||
      (args.yield_time_ms !== undefined &&
        (!Number.isSafeInteger(args.yield_time_ms) ||
          args.yield_time_ms < 0 ||
          args.yield_time_ms > 10000))
    )
      continue;
    // Muse's native shell result is an execution envelope. Never trust a model's
    // summary, an unfinished process, a nonzero exit or truncated output.
    let envelope;
    try {
      envelope = JSON.parse(item.visibleOutput);
    } catch {
      continue;
    }
    if (
      envelope.exit_code !== 0 ||
      envelope.terminal_status !== 'completed' ||
      envelope.truncated !== false ||
      envelope.command !== probe.command ||
      typeof envelope.output !== 'string'
    )
      continue;
    const lines = envelope.output.split('\n').filter((s) => s.startsWith(probe.marker));
    if (lines.length !== 1) continue;
    try {
      const result = JSON.parse(lines[0].slice(probe.marker.length));
      const names = ['processInspection', 'loopbackBind', 'loopbackConnection'];
      if (names.every((key) => ['allowed', 'denied', 'notChecked'].includes(result[key]?.status)))
        return {
          itemId: item.itemId,
          revision: item.revision,
          results: Object.fromEntries(
            names.map((key) => [
              key,
              {
                status: result[key].status,
                detail: String(result[key].detail ?? '').slice(0, 200),
              },
            ]),
          ),
        };
    } catch {
      /* A partial or malformed output is not evidence. */
    }
  }
  return null;
}
