$name = $args[0]
$roots = @($env:USERPROFILE, "E:\", "D:\", "C:\")
foreach ($root in $roots) {
    if (-not (Test-Path $root)) { continue }
    $result = Get-ChildItem -Path $root -Directory -Recurse -Depth 4 -Filter $name -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($result) {
        Write-Output $result.FullName
        exit 0
    }
}
exit 1
