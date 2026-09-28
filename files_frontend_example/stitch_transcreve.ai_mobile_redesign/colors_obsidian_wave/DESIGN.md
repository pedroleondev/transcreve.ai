---
name: Obsidian Wave
colors:
  surface: '#0f131c'
  surface-dim: '#0f131c'
  surface-bright: '#353943'
  surface-container-lowest: '#0a0e17'
  surface-container-low: '#181b25'
  surface-container: '#1c1f29'
  surface-container-high: '#262a34'
  surface-container-highest: '#31353f'
  on-surface: '#dfe2ef'
  on-surface-variant: '#b9cacb'
  inverse-surface: '#dfe2ef'
  inverse-on-surface: '#2c303a'
  outline: '#849495'
  outline-variant: '#3a494b'
  surface-tint: '#00dce6'
  primary: '#e0fdff'
  on-primary: '#00373a'
  primary-container: '#00f2fe'
  on-primary-container: '#006a70'
  inverse-primary: '#00696f'
  secondary: '#dbb8ff'
  on-secondary: '#470083'
  secondary-container: '#6807ba'
  on-secondary-container: '#d0a6ff'
  tertiary: '#e1ffec'
  on-tertiary: '#003824'
  tertiary-container: '#67f4b7'
  on-tertiary-container: '#006e4b'
  error: '#ffb4ab'
  on-error: '#690005'
  error-container: '#93000a'
  on-error-container: '#ffdad6'
  primary-fixed: '#6ff6ff'
  primary-fixed-dim: '#00dce6'
  on-primary-fixed: '#002022'
  on-primary-fixed-variant: '#004f53'
  secondary-fixed: '#efdbff'
  secondary-fixed-dim: '#dbb8ff'
  on-secondary-fixed: '#2b0052'
  on-secondary-fixed-variant: '#6600b7'
  tertiary-fixed: '#6ffbbe'
  tertiary-fixed-dim: '#4edea3'
  on-tertiary-fixed: '#002113'
  on-tertiary-fixed-variant: '#005236'
  background: '#0f131c'
  on-background: '#dfe2ef'
  surface-variant: '#31353f'
typography:
  display-lg:
    fontFamily: Plus Jakarta Sans
    fontSize: 40px
    fontWeight: '800'
    lineHeight: 48px
    letterSpacing: -0.03em
  headline-lg:
    fontFamily: Plus Jakarta Sans
    fontSize: 30px
    fontWeight: '700'
    lineHeight: 38px
    letterSpacing: -0.02em
  headline-lg-mobile:
    fontFamily: Plus Jakarta Sans
    fontSize: 24px
    fontWeight: '700'
    lineHeight: 32px
    letterSpacing: -0.02em
  headline-md:
    fontFamily: Plus Jakarta Sans
    fontSize: 20px
    fontWeight: '600'
    lineHeight: 28px
    letterSpacing: -0.015em
  headline-sm:
    fontFamily: Plus Jakarta Sans
    fontSize: 16px
    fontWeight: '600'
    lineHeight: 24px
    letterSpacing: -0.01em
  body-lg:
    fontFamily: Plus Jakarta Sans
    fontSize: 16px
    fontWeight: '400'
    lineHeight: 26px
    letterSpacing: -0.005em
  body-md:
    fontFamily: Plus Jakarta Sans
    fontSize: 14px
    fontWeight: '400'
    lineHeight: 22px
    letterSpacing: 0em
  body-sm:
    fontFamily: Plus Jakarta Sans
    fontSize: 12px
    fontWeight: '400'
    lineHeight: 18px
    letterSpacing: 0.01em
  label-lg:
    fontFamily: Plus Jakarta Sans
    fontSize: 14px
    fontWeight: '600'
    lineHeight: 20px
    letterSpacing: 0.01em
  label-md:
    fontFamily: Plus Jakarta Sans
    fontSize: 12px
    fontWeight: '600'
    lineHeight: 16px
    letterSpacing: 0.02em
  label-sm:
    fontFamily: Plus Jakarta Sans
    fontSize: 10px
    fontWeight: '700'
    lineHeight: 14px
    letterSpacing: 0.05em
rounded:
  sm: 0.25rem
  DEFAULT: 0.5rem
  md: 0.75rem
  lg: 1rem
  xl: 1.5rem
  full: 9999px
spacing:
  gutter: 1rem
  gutter-mobile: 0.75rem
  margin: 1rem
  margin-desktop: 2rem
  space-xs: 0.25rem
  space-sm: 0.5rem
  space-md: 1rem
  space-lg: 1.5rem
  space-xl: 2.5rem
---

## Brand & Style

O design system estabelece uma linguagem visual móvel, tecnológica, precisa e sofisticada para fluxos intensivos de transcrição e síntese por inteligência artificial. A experiência combina **Minimalismo Técnico** com **Acentos Luminescentes (Dark Glassmorphism)**, priorizando legibilidade instantânea sob luz solar direta ou ambientes de baixa iluminação.

### Traços de Personalidade da Marca
- **Cerebral & Preciso:** Sensação de engenharia refinada, eliminando ruídos visuais para focar estritamente na precisão do áudio e na velocidade do texto.
- **Ágil & Sem Fricção:** Projetado para operação unilateral no smartphone, com ações primárias acessíveis pelo polegar e respostas táteis imediatas.
- **Futurista & Premium:** Superfícies profundas em obsidiana e ardósia contrastadas por luzes pontuais de ciano-elétrico e violeta espectral, transmitindo processamento neural avançado sem parecer sobrecarregado.

### Audiência & Resposta Emocional
Desenvolvido para jornalistas, pesquisadores, criadores de conteúdo e desenvolvedores que dependem de fluxos contínuos de captura de áudio. A interface deve evocar confiança inabalável na acurácia do processamento, controle imediato dos dados e sensação de velocidade ultrarrápida.

## Colors

A arquitetura cromática fundamenta-se em um fundo dark ultraprofundo estruturado em três níveis de elevação tonal, pontuado por gradientes funcionais e sinais semânticos luminescentes.

### Estrutura de Cores

- **Primary (`#00F2FE` - Cyan Ray):** O pulso ativo da plataforma. Utilizado em ações de alta conversão, estados de reprodução ativa, waveforms dinâmicos e no anel de captura do Floating Action Button (FAB).
- **Secondary (`#7928CA` - Neural Violet):** A energia de inteligência artificial. Aplica-se em degradê de alta definição junto ao Cyan Ray para diferenciar recursos Pro/Max e elementos de síntese neural.
- **Tertiary (`#10B981` - Emerald Transcribed):** O estado definitivo de sucesso. Empregado em transcrições finalizadas, taxas de confiança elevadas e validação de chaves OpenRouter.
- **Neutral (`#090D16` - Deep Obsidian):** A base absoluta da interface. Conduz os fundos e cria contraste extremo para o texto branco puro e cinzas ópticos.

### Cores Semânticas de Estado
- **Processing (`#F59E0B` - Amber Pulse):** Indicador de áudio em transcrição/fila de processamento.
- **Failed / Attention (`#F43F5E` - Radiant Coral):** Erros de decodificação, limite de token ou falha de conexão.
- **Tier Max (`#EC4899` - Hyper Magenta):** Badge de altíssima precisão e diarização de locutores multimodais.
- **Tier Pro (`#8B5CF6` - Electric Violet):** Badge de modelo balanceado para fluxos profissionais diários.
- **Tier Rápido (`#06B6D4` - Velocity Cyan):** Badge para conversão rápida de voz em texto.

### Superfícies & Bordas
- **Canvas Base:** `#06080F`
- **Surface Elevation 1 (Cards, Sheets):** `#0E131F`
- **Surface Elevation 2 (Chips, Inputs, Dividers):** `#161D2E`
- **Border Subtle:** `rgba(255, 255, 255, 0.08)`
- **Border Focused:** `rgba(0, 242, 254, 0.40)`

## Typography

A tipografia utiliza exclusivamente o **Plus Jakarta Sans**, aproveitando sua geometria contemporânea, terminações limpas e proporções humanistas. A clareza sob tamanhos compactos garante consumo rápido de grandes volumes de texto transcrito em telas de proporções verticais.

### Diretrizes de Aplicação
- **Títulos e Métricas:** Usar pesos `700` e `800` com tracking negativo sutil (`-0.02em` a `-0.03em`) para compor cabeçalhos densos, modernos e impactantes.
- **Transcrição em Massa (`body-lg` e `body-md`):** Manter entrelinha generosa (`1.5` a `1.6`) para viabilizar leitura contínua e evitar fadiga visual em modo escuro.
- **Metadados, Timestamps e Badges (`label-sm` e `label-md`):** Aplicar peso `600` ou `700` com tracking ligeiramente expandido (`+0.02em` a `+0.05em`), frequentemente com letras maiúsculas em chips de status e identificadores de modelo de IA.

## Layout & Spacing

O layout é concebido a partir de uma filosofia estritamente **Mobile-First**, ancorada em um modelo de grade fluida de 4 colunas em telas portáteis, escalável para 8 colunas em tablets e 12 colunas em telas amplas.

### Zonas Ergonômicas do Smartphone
- **Thumb Zone Primária:** Os gatilhos de controle rápido, botão central de gravação (FAB), filtros de projetos e controles de reprodução do player residem nos 40% inferiores da viewport.
- **Top Safe Area:** Dedicada a buscas ativas, status de conectividade do motor OpenRouter e alternador de espaços de trabalho.

### Ritmo Vertical e Breakpoints
- **Mobile (< 640px):** Margem externa fixa de `1rem` (16px), calhas (`gutter-mobile`) de `0.75rem` (12px), respeitando as zonas de safe-area superior e inferior do sistema operacional.
- **Tablet (640px - 1024px):** Margens de `1.5rem`, grade de 8 colunas.
- **Desktop (> 1024px):** Margem de `2rem`, centralização com container máximo de `1200px`.

## Elevation & Depth

A profundidade na interface rejeita sombras difusas puramente negras em favor de **camadas tonais sobrepostas com brilhos perimetrais sutis (ambient cyan/violet glow)** e desfoques ópticos de fundo (backdrop-filter glassmorphism).

### Níveis de Superfície
- **Nível 0 (Canvas):** Fundo absoluto `#06080F`. Superfície opaca sem elevação.
- **Nível 1 (Cartões & Seções):** Fundo `#0E131F` com borda sutil de `1px` em `rgba(255, 255, 255, 0.06)`. Nenhuma sombra projetada no estado inativo; no estado pressionado/hover, ganha brilho de borda em `rgba(0, 242, 254, 0.25)`.
- **Nível 2 (Floating Action Button & Bottom Bar):** Efeito de vidro escurecido fosco com `background: rgba(14, 19, 31, 0.85)` e `backdrop-filter: blur(20px)`. Borda superior em `rgba(255, 255, 255, 0.12)`.
- **Nível 3 (Drawers & Modais OpenRouter):** Fundo `#121826`, sombra de oclusão `0 -12px 32px rgba(0, 0, 0, 0.75)` associada a um overlay backdrop de `rgba(6, 8, 15, 0.8)` com desfoque de 8px.
- **Luminescent Halo (Aura IA):** Elementos em gravação ou processamento ativo projetam sombra com dispersão colorida: `0 0 24px rgba(0, 242, 254, 0.35)` ou `0 0 24px rgba(245, 158, 11, 0.35)`.

## Shapes

A linguagem de formas adota a escala **Rounded** (índice 2), promovendo contornos táteis que equilibram ergonomia móvel e estética técnica.

- **Pills (`rounded-full`):** Reservados estritamente para chips de status de transcrição, badges de modelo (Max/Pro/Rápido), botões de filtro no carrossel superior e botões primários compactos.
- **Cards e Painéis (`rounded-lg` / 1rem):** Recipientes de transcrições, cartões de arquivo de áudio e caixas de busca.
- **Bottom Sheets e Modais (`rounded-t-2xl` / 1.5rem):** Folhas deslizantes ascendentes para parâmetros de chave de API e propriedades do projeto.
- **Inputs e Controles (`rounded-md` / 0.5rem):** Campos de texto, seletores de idioma e opções de diarização.

## Components

### Barra de Navegação Inferior & Floating Action Button (FAB)
- **Barra Inferior:** Barra flutuante suspensa a `1rem` da margem inferior ou dock fixo com safe-area. Superfície translúcida com `backdrop-filter: blur(16px)`, borda sutil de 1px e 4 ícones utilitários (Transcrições, Pastas, Destaques, Configurações).
- **FAB de Captura ('Transcrever'):** Posicionado centralmente ou no canto inferior direito. Botão circular de 56px com gradiente de `45deg` entre `#00F2FE` e `#7928CA`. No estado de gravação ativa, o botão pulsa concentricamente com anéis em onda ciano e aciona feedback háptico.

### Cards de Transcrição
- **Estrutura:** Container estruturado com preenchimento interno de `space-md`, fundo em `#0E131F`, cantos `rounded-lg` e borda de baixa opacidade.
- **Cabeçalho do Card:** Nome do arquivo de voz truncado (`headline-sm`), duração em formato de áudio (`04:12`) e badge de modelo de IA.
- **Waveform Tátil:** Linha de onda sonora em miniatura mostrando progresso de reprodução com cursor em `#00F2FE`.
- **Chips de Status (Pill Luminescente):**
  - *Concluído:* Fundo `rgba(16, 185, 129, 0.12)`, texto e ícone `#10B981`, micro-borda `rgba(16, 185, 129, 0.30)`.
  - *Em processamento:* Fundo `rgba(245, 158, 11, 0.12)`, texto `#F59E0B`, ponto luminoso pulsante (animação CSS pulse 1.5s).
  - *Falha / Pendente:* Fundo `rgba(244, 63, 94, 0.12)`, texto `#F43F5E`, ícone de exclamação e botão inline para retentativa imediata.

### Badges de Modo de IA
- Formato pílula ultra-compacto com tipografia `label-sm` em maiúsculas:
  - **Max:** Gradiente suave de fundo `#EC4899` para `#8B5CF6`, texto `#FFFFFF`.
  - **Pro:** Borda fina `#8B5CF6`, fundo `rgba(139, 92, 246, 0.15)`, texto `#C4B5FD`.
  - **Rápido:** Borda fina `#06B6D4`, fundo `rgba(6, 182, 212, 0.15)`, texto `#67E8F9`.

### Carrossel de Filtros e Pastas
- Fileira horizontal com rolagem fluida por toque na borda superior da tela.
- **Pills Deselecionadas:** Fundo `#161D2E`, texto atenuado (`#94A3B8`), sem borda contrastante.
- **Pill Ativa:** Fundo branco puro ou Cyan Ray `#00F2FE`, texto escuro `#090D16` para contraste extremo instantâneo.
- Suporte a contadores numéricos de itens entre parênteses dentro de cada filtro.

### Drawer / Bottom Sheet (Chaves de API OpenRouter & Pastas)
- Abertura com física amortecida de baixo para cima, cobrindo até 85% da altura da tela com alça de arraste (drag handle) de 36x4px no topo.
- **Campo de Chave API:** Input monocromático com máscara de caracteres (`sk-or-••••••••`), botão de visualização em olho e botão tátil de teste de conexão com ping dinâmico em ms.

### Botões e Entradas de Dados
- **Botão Primário:** Fundo sólido `#00F2FE` com texto `#06080F`, peso `600`, transição ativa com redução de escala para `0.97` no toque.
- **Inputs de Busca & Edição:** Fundo `#121826`, borda `1px solid rgba(255, 255, 255, 0.1)`, ícone de busca em ciano opaco à esquerda e botão de limpeza rápida à direita.