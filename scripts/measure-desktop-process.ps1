param(
    [Parameter(Mandatory = $true)][string]$Executable,
    [Parameter(Mandatory = $true)][string]$Output,
    [Parameter(Mandatory = $true)][string]$Log,
    [string]$Arguments = 'desktop_performance_workloads --exact --test-threads=1',
    [int]$SampleIntervalMs = 100
)
$ErrorActionPreference = 'Stop'
if ((Test-Path $Output) -or (Test-Path $Log) -or (Test-Path "$Log.stderr")) {
    throw 'Evidence output already exists; choose new paths.'
}
$resolvedExecutable = (Resolve-Path $Executable).Path
$timer = [Diagnostics.Stopwatch]::StartNew()
$process = Start-Process -FilePath $resolvedExecutable -ArgumentList $Arguments -PassThru -RedirectStandardOutput $Log -RedirectStandardError "$Log.stderr"
# Retain the native process handle before exit so Windows PowerShell can read ExitCode.
$null = $process.Handle
$samples = [Collections.Generic.List[object]]::new()
while (-not $process.HasExited) {
    $process.Refresh()
    $samples.Add([pscustomobject]@{
        elapsedMs = $timer.Elapsed.TotalMilliseconds
        workingSetBytes = $process.WorkingSet64
        privateBytes = $process.PrivateMemorySize64
        totalCpuMs = $process.TotalProcessorTime.TotalMilliseconds
    })
    Start-Sleep -Milliseconds $SampleIntervalMs
}
$process.WaitForExit()
$timer.Stop()
$process.Refresh()
[pscustomobject]@{
    executable = [IO.Path]::GetFileName($resolvedExecutable)
    arguments = $Arguments
    exitCode = $process.ExitCode
    elapsedMs = $timer.Elapsed.TotalMilliseconds
    totalCpuMs = $process.TotalProcessorTime.TotalMilliseconds
    peakWorkingSetBytes = $process.PeakWorkingSet64
    scope = 'Only the benchmark process; not WebView2, production app, or system-wide memory. Polling may miss short peaks.'
    sampleIntervalMs = $SampleIntervalMs
    samples = $samples
} | ConvertTo-Json -Depth 5 | Set-Content -Path $Output -Encoding UTF8
if ($process.ExitCode -ne 0) { throw "Benchmark failed with exit code $($process.ExitCode); inspect $Log" }
