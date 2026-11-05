// Set only the DACL: an owner may have WRITE_DAC without WRITE_OWNER or restore privileges.
using System;
using System.IO;
using System.Security.AccessControl;
using System.Security.Principal;

class WindowsAcl {
    static int Main(string[] args) {
        try {
            string file = args[0];
            bool directory = args[1] == "directory";
            FileSystemSecurity acl = directory ? (FileSystemSecurity)new DirectorySecurity() : new FileSecurity();
            acl.SetAccessRuleProtection(true, false);
            var inherit = directory ? InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit : InheritanceFlags.None;
            acl.AddAccessRule(new FileSystemAccessRule(WindowsIdentity.GetCurrent().User, FileSystemRights.FullControl,
                inherit, PropagationFlags.None, AccessControlType.Allow));
            if (args.Length == 4) {
                var agent = new SecurityIdentifier(args[2]);
                if (!agent.IsAccountSid()) throw new Exception("Expected a sandbox user SID");
                var rights = FileSystemRights.ReadAndExecute;
                if (args[3] == "edit") rights |= FileSystemRights.Write;
                acl.AddAccessRule(new FileSystemAccessRule(agent, rights, inherit, PropagationFlags.None, AccessControlType.Allow));
            }
            if (directory) Directory.SetAccessControl(file, (DirectorySecurity)acl);
            else File.SetAccessControl(file, (FileSecurity)acl);
            if (args.Length == 4) {
                string context = Path.Combine(file, "context.json");
                var data = File.GetAccessControl(context);
                data.SetAccessRuleProtection(false, false);
                File.SetAccessControl(context, data);
            }
            return 0;
        } catch (Exception error) { Console.Error.WriteLine(error.Message); return 1; }
    }
}
