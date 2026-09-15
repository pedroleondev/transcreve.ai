# Gera tests/fixtures/long/sample-2h.ogg: ~2h de audio sintetico com 2 vozes
# (Maria pt-BR + Zira en-US) intercaladas, com pausas de 1,5s entre falas.
# Serve para T-19 (audio longo, split em blocos) e T-22 (dois locutores).
# Requer Windows (System.Speech) e ffmpeg no PATH. A pasta long/ e gitignored.
#
# Uso:  powershell -File tests/fixtures/make-long-sample.ps1 [-Hours 2]

param([double]$Hours = 2)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
$dir = Join-Path $PSScriptRoot 'long'
New-Item -ItemType Directory -Force $dir | Out-Null

$frases = @(
  @('Microsoft Maria Desktop', 'Bom dia, aqui e a Maria da equipe comercial. Vou apresentar o plano de saude empresarial e tirar todas as duvidas sobre carencia e cobertura.'),
  @('Microsoft Zira Desktop',  'Hello, I would like to understand the difference between the basic plan and the premium plan, especially regarding hospital coverage.'),
  @('Microsoft Maria Desktop', 'O primeiro passo do nosso processo e a qualificacao. Perguntamos quantas vidas, se existe CNPJ ativo e qual a cidade de atendimento.'),
  @('Microsoft Zira Desktop',  'Okay. And what happens after the qualification step? Do you send a proposal by email or by WhatsApp?'),
  @('Microsoft Maria Desktop', 'Depois da qualificacao, montamos a cotacao com tres operadoras, enviamos pelo WhatsApp e agendamos uma ligacao de fechamento em ate dois dias uteis.'),
  @('Microsoft Zira Desktop',  'That sounds good. My main objection is the price. Can you offer a discount if we sign for twelve months?'),
  @('Microsoft Maria Desktop', 'Sobre o preco, temos um desconto de dez por cento para contratos anuais e a primeira mensalidade sai apenas apos a aprovacao da declaracao de saude.'),
  @('Microsoft Zira Desktop',  'Perfect. Please send me the proposal and I will review it with my partner this afternoon.')
)

$list = Join-Path $dir 'list.txt'
Set-Content $list '' -Encoding ascii
ffmpeg -y -loglevel error -f lavfi -i anullsrc=r=16000:cl=mono -t 1.5 (Join-Path $dir 'sil.wav')

for ($i = 0; $i -lt $frases.Count; $i++) {
  $raw = Join-Path $dir "raw_$i.wav"
  $out = Join-Path $dir "f$i.wav"
  $s = New-Object System.Speech.Synthesis.SpeechSynthesizer
  $s.SelectVoice($frases[$i][0])
  $s.SetOutputToWaveFile($raw)
  $s.Speak($frases[$i][1])
  $s.Dispose()
  ffmpeg -y -loglevel error -i $raw -ar 16000 -ac 1 $out
  Add-Content $list "file 'f$i.wav'"
  Add-Content $list "file 'sil.wav'"
}

$rodada = Join-Path $dir 'rodada.wav'
ffmpeg -y -loglevel error -f concat -safe 0 -i $list -c copy $rodada

$rodadaSec = [double](ffprobe -v error -show_entries format=duration -of csv=p=0 $rodada)
$loops = [math]::Ceiling(($Hours * 3600) / $rodadaSec) - 1
$final = Join-Path $dir ("sample-{0}h.ogg" -f $Hours)
ffmpeg -y -loglevel error -stream_loop $loops -i $rodada -c:a libvorbis -qscale:a 2 $final

Remove-Item (Join-Path $dir 'raw_*.wav'), (Join-Path $dir 'f*.wav'), (Join-Path $dir 'sil.wav'), $list, $rodada -Force
Write-Host "Gerado: $final"
ffprobe -v error -show_entries format=duration -of default=nw=1 $final
