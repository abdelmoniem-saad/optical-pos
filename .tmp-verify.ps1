$log = Join-Path $env:TEMP 'fv3.log'
$env:Path = 'C:\Users\AUC\nodejs;' + $env:Path
Set-Location 'C:\Users\AUC\PycharmProjects\optical-pos\web'
'REFRESH' | Out-File -FilePath $log
npm run build *> $log
"BUILD_EXIT=$LASTEXITCODE" | Out-File -FilePath $log -Append
npm run lint *>> $log
"LINT_EXIT=$LASTEXITCODE" | Out-File -FilePath $log -Append
npm test *>> $log
"TEST_EXIT=$LASTEXITCODE" | Out-File -FilePath $log -Append
'DONE' | Out-File -FilePath $log -Append
