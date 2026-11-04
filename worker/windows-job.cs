// The only long-lived job handle belongs to this guardian, never to the worker or its children.
using System;
using System.ComponentModel;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

class WindowsJob {
    [StructLayout(LayoutKind.Sequential)] struct SecurityAttributes { public int Length; public IntPtr Descriptor; public int Inherit; }
    [StructLayout(LayoutKind.Sequential)] struct StartupInfo {
        public int Size; public string Reserved, Desktop, Title; public int X, Y, Width, Height, XChars, YChars, Fill, Flags;
        public short Show, ReservedSize; public IntPtr ReservedData, Input, Output, Error;
    }
    [StructLayout(LayoutKind.Sequential)] struct ProcessInfo { public IntPtr Process, Thread; public int Pid, Tid; }
    [StructLayout(LayoutKind.Sequential)] struct StartupInfoEx { public StartupInfo Info; public IntPtr Attributes; }
    [StructLayout(LayoutKind.Sequential)] struct BasicLimits {
        public long ProcessTime, JobTime; public uint Flags; public UIntPtr MinWorking, MaxWorking; public uint ActiveLimit;
        public UIntPtr Affinity; public uint Priority, Scheduling;
    }
    [StructLayout(LayoutKind.Sequential)] struct IoCounters { public ulong Read, Write, Other, ReadBytes, WriteBytes, OtherBytes; }
    [StructLayout(LayoutKind.Sequential)] struct ExtendedLimits {
        public BasicLimits Basic; public IoCounters Io; public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
    }
    [StructLayout(LayoutKind.Sequential)] struct Accounting {
        public long User, Kernel, PeriodUser, PeriodKernel; public uint Faults, Total, Active, Terminated;
    }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr OpenJobObject(uint access, bool inherit, string name);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr job, int kind, ref ExtendedLimits info, int length);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool QueryInformationJobObject(IntPtr job, int kind, out Accounting info, int length, IntPtr returned);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr bytes);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute, IntPtr value, IntPtr size, IntPtr previous, IntPtr returned);
    [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateJobObject(IntPtr job, uint code);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", SetLastError = true)] static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll", SetLastError = true)] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateProcess(IntPtr process, uint code);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool CreateProcess(
        string application, StringBuilder command, IntPtr processSecurity, IntPtr threadSecurity, bool inherit,
        uint flags, IntPtr environment, string cwd, ref StartupInfoEx startup, out ProcessInfo process);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr CreateFile(
        string name, uint access, uint share, ref SecurityAttributes attributes, uint creation, uint flags, IntPtr template);

    static void Check(bool okay) { if (!okay) throw new Win32Exception(Marshal.GetLastWin32Error()); }
    static string Quote(string value) {
        StringBuilder result = new StringBuilder("\"");
        int slashes = 0;
        foreach (char c in value) {
            if (c == '\\') { slashes++; continue; }
            result.Append('\\', slashes * (c == '"' ? 2 : 1) + (c == '"' ? 1 : 0));
            result.Append(c); slashes = 0;
        }
        return result.Append('\\', slashes * 2).Append('"').ToString();
    }
    static uint Active(IntPtr job) {
        Accounting info;
        Check(QueryInformationJobObject(job, 1, out info, Marshal.SizeOf(typeof(Accounting)), IntPtr.Zero));
        return info.Active;
    }
    static IntPtr FileHandle(string file, bool input) {
        SecurityAttributes attrs = new SecurityAttributes { Length = Marshal.SizeOf(typeof(SecurityAttributes)), Inherit = 1 };
        IntPtr handle = CreateFile(file, input ? 0x80000000u : 0x40000000u, 7, ref attrs, input ? 3u : 2u, 0x80, IntPtr.Zero);
        if (handle == new IntPtr(-1)) throw new Win32Exception(Marshal.GetLastWin32Error());
        return handle;
    }
    static void Publish(string file, string text) {
        System.IO.File.WriteAllText(file + ".tmp", text, new UTF8Encoding(false));
        System.IO.File.Move(file + ".tmp", file);
    }
    static int Run(string name, string spec) {
        FileStream lease = new FileStream(spec, FileMode.Open, FileAccess.ReadWrite, FileShare.None);
        string[] parts;
        try {
            List<string> lines = new List<string>();
            using (StreamReader reader = new StreamReader(lease, Encoding.UTF8, true, 1024, true)) {
                string line;
                while ((line = reader.ReadLine()) != null) lines.Add(line);
            }
            parts = lines.ToArray();
            if (parts.Length < 6) throw new Exception("Startup was revoked");
            for (int i = 0; i < parts.Length; i++) parts[i] = Encoding.UTF8.GetString(Convert.FromBase64String(parts[i]));
        } catch {
            lease.Dispose(); throw;
        }
        string cwd = parts[0], output = parts[1], error = parts[2], exit = parts[3], ready = parts[4];
        IntPtr job = IntPtr.Zero, input = IntPtr.Zero, stdout = IntPtr.Zero, stderr = IntPtr.Zero;
        IntPtr attributes = IntPtr.Zero, jobList = IntPtr.Zero;
        ProcessInfo process = new ProcessInfo();
        uint code = 1;
        try {
            job = CreateJobObject(IntPtr.Zero, name);
            Check(job != IntPtr.Zero);
            if (Marshal.GetLastWin32Error() == 183) {
                CloseHandle(job); job = IntPtr.Zero;
                throw new Exception("Job already exists");
            }
            ExtendedLimits limits = new ExtendedLimits();
            limits.Basic.Flags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE; no breakaway flags.
            Check(SetInformationJobObject(job, 9, ref limits, Marshal.SizeOf(typeof(ExtendedLimits))));
            input = FileHandle("NUL", true); stdout = FileHandle(output, false); stderr = FileHandle(error, false);
            IntPtr bytes = IntPtr.Zero;
            InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref bytes);
            attributes = Marshal.AllocHGlobal(bytes);
            Check(InitializeProcThreadAttributeList(attributes, 1, 0, ref bytes));
            jobList = Marshal.AllocHGlobal(IntPtr.Size);
            Marshal.WriteIntPtr(jobList, job);
            // Atomic membership closes the guardian-death window between CreateProcess and AssignProcessToJobObject.
            Check(UpdateProcThreadAttribute(attributes, 0, new IntPtr(0x2000d), jobList, new IntPtr(IntPtr.Size), IntPtr.Zero, IntPtr.Zero));
            StartupInfoEx startup = new StartupInfoEx { Info = new StartupInfo {
                Size = Marshal.SizeOf(typeof(StartupInfoEx)), Flags = 0x100, Input = input, Output = stdout, Error = stderr },
                Attributes = attributes };
            StringBuilder command = new StringBuilder();
            for (int i = 5; i < parts.Length; i++) { if (i > 5) command.Append(' '); command.Append(Quote(parts[i])); }
            Check(CreateProcess(parts[5], command, IntPtr.Zero, IntPtr.Zero, true, 0x08080004, IntPtr.Zero, cwd, ref startup, out process));
            Publish(ready, process.Pid.ToString());
            if (ResumeThread(process.Thread) == 0xffffffff) throw new Win32Exception(Marshal.GetLastWin32Error());
            lease.Dispose(); lease = null;
            Check(WaitForSingleObject(process.Process, 0xffffffff) == 0);
            Check(GetExitCodeProcess(process.Process, out code));
            Check(TerminateJobObject(job, code));
            while (Active(job) != 0) Thread.Sleep(10);
        } catch (Exception failure) {
            code = 1;
            if (process.Process != IntPtr.Zero) TerminateProcess(process.Process, 1);
            if (job != IntPtr.Zero) {
                Check(TerminateJobObject(job, 1));
                while (Active(job) != 0) Thread.Sleep(10);
            }
            System.IO.File.AppendAllText(error, failure.Message + Environment.NewLine, Encoding.UTF8);
        } finally {
            if (lease != null) lease.Dispose();
            if (attributes != IntPtr.Zero) { DeleteProcThreadAttributeList(attributes); Marshal.FreeHGlobal(attributes); }
            if (jobList != IntPtr.Zero) Marshal.FreeHGlobal(jobList);
            foreach (IntPtr handle in new IntPtr[] { process.Thread, process.Process, input, stdout, stderr, job })
                if (handle != IntPtr.Zero && handle != new IntPtr(-1)) CloseHandle(handle);
        }
        Publish(exit, code.ToString());
        return 0;
    }
    static int RevokeStartup(string name, string spec, bool stopping) {
        try {
            // The same exclusive handle either belongs to a starting guardian or revokes its permission to start.
            using (FileStream lease = new FileStream(spec, FileMode.Open, FileAccess.ReadWrite, FileShare.None)) {
                IntPtr job = OpenJobObject(stopping ? 0x8u : 0x4u, false, name);
                if (job != IntPtr.Zero) {
                    try { if (stopping) Check(TerminateJobObject(job, 1)); return 0; }
                    finally { CloseHandle(job); }
                }
                int error = Marshal.GetLastWin32Error();
                if (error != 2) throw new Win32Exception(error);
                lease.SetLength(0); lease.Flush(true);
            }
            return 3;
        } catch (IOException failure) {
            int error = Marshal.GetHRForException(failure) & 0xffff;
            if (error == 2 || error == 3) return 3;
            if (error == 32 || error == 33) return 0;
            throw;
        }
    }
    static int Main(string[] args) {
        try {
            if (args[0] == "run") return Run(args[1], args[2]);
            IntPtr job = OpenJobObject(args[0] == "stop" ? 0x8u : 0x4u, false, args[1]);
            if (job == IntPtr.Zero) {
                int error = Marshal.GetLastWin32Error();
                if (error == 2) return RevokeStartup(args[1], args[2], args[0] == "stop");
                throw new Win32Exception(error);
            }
            try { if (args[0] == "stop") Check(TerminateJobObject(job, 1)); return 0; }
            finally { CloseHandle(job); }
        } catch (Exception failure) { Console.Error.WriteLine(failure.Message); return 1; }
    }
}
