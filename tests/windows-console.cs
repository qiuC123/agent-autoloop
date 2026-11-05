// Send real console events only to a newly created hidden fixture console, never to the test runner's console.
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

class TestConsole {
    [StructLayout(LayoutKind.Sequential)] struct Startup {
        public int Size; public string Reserved, Desktop, Title; public int X, Y, Width, Height, XChars, YChars, Fill, Flags;
        public short Show, ReservedSize; public IntPtr ReservedData, Input, Output, Error;
    }
    [StructLayout(LayoutKind.Sequential)] struct ProcessInfo { public IntPtr Process, Thread; public int Pid, Tid; }
    delegate bool Handler(uint signal);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool FreeConsole();
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool AttachConsole(uint pid);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetConsoleCtrlHandler(Handler handler, bool add);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool GenerateConsoleCtrlEvent(uint signal, uint group);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CreateProcess(
        string application, StringBuilder command, IntPtr processSecurity, IntPtr threadSecurity, bool inherit,
        uint flags, IntPtr environment, string cwd, ref Startup startup, out ProcessInfo process);
    [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle, uint ms);
    [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
    [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr process, uint code);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    static void Check(bool ok) { if (!ok) throw new Win32Exception(Marshal.GetLastWin32Error()); }
    static string Quote(string value) {
        var result = new StringBuilder("\""); int slashes = 0;
        foreach(char c in value) {
            if(c == '\\') { slashes++; continue; }
            result.Append('\\', slashes * (c == '"' ? 2 : 1) + (c == '"' ? 1 : 0));
            result.Append(c); slashes = 0;
        }
        return result.Append('\\', slashes * 2).Append('"').ToString();
    }
    static int Main(string[] args) {
        if(args[0] == "victim") { Thread.Sleep(Timeout.Infinite); return 0; }
        if(args[0] == "send") {
            FreeConsole(); Check(AttachConsole(uint.Parse(args[1])));
            Handler ignore = signal => true;
            Check(SetConsoleCtrlHandler(ignore, true));
            Check(GenerateConsoleCtrlEvent(uint.Parse(args[2]), 0));
            Thread.Sleep(200); FreeConsole(); GC.KeepAlive(ignore); return 0;
        }
        var command = new StringBuilder();
        foreach(var arg in args) { if(command.Length > 0) command.Append(' '); command.Append(Quote(arg)); }
        var startup = new Startup { Size = Marshal.SizeOf(typeof(Startup)), Flags = 1, Show = 0 };
        ProcessInfo process;
        Check(CreateProcess(args[0], command, IntPtr.Zero, IntPtr.Zero, false, 0x10, IntPtr.Zero, null, ref startup, out process));
        try {
            Console.WriteLine(process.Pid);
            if(WaitForSingleObject(process.Process, 30000) != 0) { TerminateProcess(process.Process, 1); return 1; }
            uint code; Check(GetExitCodeProcess(process.Process, out code)); return unchecked((int)code);
        } finally { CloseHandle(process.Thread); CloseHandle(process.Process); }
    }
}
