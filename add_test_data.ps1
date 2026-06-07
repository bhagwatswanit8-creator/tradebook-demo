# Add test data to local database
$db = Get-Content 'data\local-db.json' | ConvertFrom-Json

$testUser = @{
  id = 'dashboard-test-user'
  name = 'Dashboard Test'
  email = 'dashboard.test@example.com'
  plan = 'Pro Journal Beta'
  passwordHash = 'a' * 80 + ':' + 'b' * 128
  createdAt = (Get-Date -Format 'o')
  updatedAt = (Get-Date -Format 'o')
}
$db.users += $testUser

$pnlValues = @(150, -100, 200, -75, 125)
$exitValues = @(4835, 4795, 4850, 4810, 4840)
$sessions = @('London', 'New York', 'Overlap', 'Asia')
$strategies = @('Liquidity Sweep', 'Breakout', 'Pullback', 'News Reaction')

$trades = @()
for ($i = 0; $i -lt 5; $i++) {
  $date = (Get-Date).AddDays(-$i).ToString('yyyy-MM-dd')
  $trades += @{
    id = "trade-{0}" -f $i
    userId = 'dashboard-test-user'
    date = $date
    symbol = 'XAUUSD'
    session = $sessions[$i % 4]
    strategy = $strategies[$i % 4]
    direction = if ($i % 2 -eq 0) { 'Long' } else { 'Short' }
    entry = [double](4820 + ($i * 10))
    exit = [double]($exitValues[$i])
    lotSize = 0.01
    pnl = $pnlValues[$i]
    risk = 1
    note = "Test trade {0}" -f ($i + 1)
    source = 'manual'
    createdAt = (Get-Date -Format 'o')
    updatedAt = (Get-Date -Format 'o')
  }
}

$db.trades = @($trades) + $db.trades

$db | ConvertTo-Json -Depth 10 | Set-Content 'data\local-db.json'
Write-Host "Test data added successfully"
