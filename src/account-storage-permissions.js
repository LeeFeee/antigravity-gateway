'use strict';

const fs = require('node:fs');
const { execFileSync } = require('node:child_process');

// POSIX mode bits do not restrict Windows DACLs. Replace the DACL with a
// protected, current-user-only rule; child files inherit that rule before any
// credential bytes are written. Paths are data in an encoded PowerShell
// command, never shell arguments interpolated into a command line.
function windowsAclScript(file, directory) {
  const literal = `'${String(file).replace(/'/g, "''")}'`;
  return `$ErrorActionPreference='Stop'; $p=${literal}; `
    + '$sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User; '
    + `$acl=New-Object System.Security.AccessControl.${directory ? 'DirectorySecurity' : 'FileSecurity'}; `
    + '$acl.SetOwner($sid); $acl.SetAccessRuleProtection($true,$false); '
    + '$rule=New-Object System.Security.AccessControl.FileSystemAccessRule('
    + `$sid,'FullControl','${directory ? 'ContainerInherit, ObjectInherit' : 'None'}','None','Allow'); `
    + '$acl.AddAccessRule($rule); Set-Acl -LiteralPath $p -AclObject $acl; '
    + '$check=Get-Acl -LiteralPath $p; '
    + 'if (!$check.AreAccessRulesProtected) {throw "Credential ACL inheritance remains enabled"}; '
    + '$rules=$check.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier]); '
    + 'if ($rules.Count -ne 1 -or $rules[0].IdentityReference.Value -ne $sid.Value '
    + '-or $rules[0].AccessControlType -ne "Allow" '
    + '-or $rules[0].FileSystemRights -ne [System.Security.AccessControl.FileSystemRights]::FullControl) '
    + '{throw "Credential ACL verification failed"};';
}

class AccountStoragePermissions {
  constructor({ fsImpl = fs, platform = process.platform, execFileSyncImpl = execFileSync } = {}) {
    this.fs = fsImpl;
    this.platform = platform;
    this.exec = execFileSyncImpl;
    this.secured = new Map();
  }

  protect(file, directory) {
    const before = this.fs.lstatSync(file);
    if (before.isSymbolicLink() || (directory ? !before.isDirectory() : !before.isFile())) {
      throw new Error('账号凭据路径必须是普通目录或文件，不能使用符号链接。');
    }
    if (this.platform !== 'win32') {
      const mode = directory ? 0o700 : 0o600;
      if ((before.mode & 0o777) !== mode) this.fs.chmodSync(file, mode);
      if ((this.fs.statSync(file).mode & 0o777) !== mode) throw new Error('无法设置账号凭据的私有权限。');
      return;
    }
    const signature = stat => `${stat.dev}:${stat.ino}:${stat.size}:${stat.ctimeMs}:${stat.mtimeMs}`;
    if (this.secured.get(file) === signature(before)) return;
    const encoded = Buffer.from(windowsAclScript(file, directory), 'utf16le').toString('base64');
    this.exec('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
      windowsHide: true, stdio: 'pipe', timeout: 15_000
    });
    this.secured.set(file, signature(this.fs.lstatSync(file)));
    while (this.secured.size > 256) this.secured.delete(this.secured.keys().next().value);
  }

  directory(file) { this.protect(file, true); }
  file(file) { this.protect(file, false); }
}

module.exports = { AccountStoragePermissions, windowsAclScript };
