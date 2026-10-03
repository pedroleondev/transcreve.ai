# Design Tokens — Falou.ai "Obsidian Wave" (oficial)

> Esta é a **referência oficial** da paleta. O `DESIGN.md` do Stitch
> (`files_frontend_example/stitch_transcreve.ai_mobile_redesign/colors_obsidian_wave/`)
> é material de origem — em caso de divergência, **este documento e o
> `tokens.css`** mandam. Implementado na **T-29 Fase 1** (03/10/2026).

## Fonte

**Plus Jakarta Sans** (Google Fonts), pesos 400/500/600/700/800. Fallback: Inter, sans-serif.
Tracking: títulos `-0.02em` a `-0.03em`; transcrição em massa com entrelinha 1.5–1.6;
metadados/badges com `+0.02em` a `+0.05em` (geralmente maiúsculas).

## Slots semânticos (alternam com o tema)

Definidos em `tokens.css` como RGB triplos (`rgb(var(--surface) / <alpha-value>)` no Tailwind).

| Slot | Escuro (Obsidian) | Claro | Uso |
|---|---|---|---|
| `--canvas` | `#06080F` | `#F5F7FA` | fundo da página (Nível 0) |
| `--surface` | `#0E131F` | `#FFFFFF` | cards, sheets (Nível 1) |
| `--raised` | `#161D2E` | `#EEF2F6` | chips, inputs, hover (Nível 2) |
| `--ink` | `#DFE2EF` | `#10151F` | texto primário |
| `--copy` | `#B9CACB` | `#3C4657` | texto secundário |
| `--muted` | `#849495` | `#64748B` | metadados |
| `--line` | `#212631`* | `#D8DEE7` | bordas |
| `--accent` | `#00F2FE` | `#00A6B0` | ações de alta conversão |
| `--accent-soft` | `#0C2E3A`* | `#E6F6F7` | fundos de acento ~12%/10% |

\* blend sólido equivalente a `rgba(255,255,255,.08)` / `rgba(0,242,254,.12)` sobre a surface.

## Cores de marca (constantes, `--wave-*` / classes Tailwind `wave-*`)

| Token | Hex | Uso |
|---|---|---|
| Cyan Ray | `#00F2FE` | ações, player ativo, FAB |
| Neural Violet | `#7928CA` | IA, síntese, card Pro |
| Emerald | `#10B981` | concluído, sucesso |
| Amber Pulse | `#F59E0B` | processando |
| Radiant Coral | `#F43F5E` | erro, falha |
| Hyper Magenta | `#EC4899` | tier Max |
| Electric Violet | `#8B5CF6` | tier Pro |
| Velocity Cyan | `#06B6D4` | tier Rápido |

## Raios

`sm 0.25rem` · `DEFAULT 0.5rem` · `md 0.75rem` · `lg 1rem` · `xl 1.5rem` · `full 9999px`.
Pills só em chips de status/badges/filtros; cards em `rounded-lg`; sheets `rounded-t-2xl`.

## Regras de ouro do redesign

1. **Glow:** no máximo 1 elemento por viewport (`--glow-cyan` / `--glow-amber`), **nunca no claro**.
2. **Gradiente ciano→violeta:** só em logo, H1, FAB e card Pro.
3. **Waveform:** só no player (canvas + rAF) — nunca em todos os cards da lista.
4. **Glassmorphism:** só em elementos fixos (bottom bar/drawer), nunca em itens de lista.
5. **Mobile-first:** cada tela entrega primeiro <640px, depois ≥1024px.
6. **Claro:** ciano puro falha contraste em fundo branco — usar sempre `#00A6B0`; glow desligado.

## Tema claro

Derivado por sombreamento (mesma arquitetura de elevação invertida). Auditoria AA
do claro é critério de aceite da F4.
