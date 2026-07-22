/**
 * UI string tables. **English is the source of truth** — its keys are the `TranslationKey`
 * type, so a typo or an unknown key fails typecheck; other locales are partial and fall back
 * to English at lookup. Values use `{param}` placeholders for interpolation.
 *
 * The non-English strings are seeded translations of standard, short UI terms — accurate for
 * these but flag for a native-speaker review before shipping. CJK (ja/ko/zh) render via the
 * device fonts; `ar` is RTL (layout mirroring is a later pass).
 */
export const en = {
  'pause.title': 'Paused',
  'pause.resume': 'Resume',
  'pause.restart': 'Restart',
  'pause.sensitivity': 'Mouse sensitivity',
  'pause.players': 'Players',
  'pause.self': '{name} (you)',
  'pause.language': 'Language',
}

export type TranslationKey = keyof typeof en
type Table = Partial<Record<TranslationKey, string>>

export const es: Table = {
  'pause.title': 'Pausa',
  'pause.resume': 'Reanudar',
  'pause.restart': 'Reiniciar',
  'pause.sensitivity': 'Sensibilidad del ratón',
  'pause.players': 'Jugadores',
  'pause.self': '{name} (tú)',
  'pause.language': 'Idioma',
}
export const fr: Table = {
  'pause.title': 'Pause',
  'pause.resume': 'Reprendre',
  'pause.restart': 'Recommencer',
  'pause.sensitivity': 'Sensibilité de la souris',
  'pause.players': 'Joueurs',
  'pause.self': '{name} (toi)',
  'pause.language': 'Langue',
}
export const nl: Table = {
  'pause.title': 'Gepauzeerd',
  'pause.resume': 'Hervatten',
  'pause.restart': 'Opnieuw',
  'pause.sensitivity': 'Muisgevoeligheid',
  'pause.players': 'Spelers',
  'pause.self': '{name} (jij)',
  'pause.language': 'Taal',
}
export const pt: Table = {
  'pause.title': 'Pausado',
  'pause.resume': 'Continuar',
  'pause.restart': 'Reiniciar',
  'pause.sensitivity': 'Sensibilidade do mouse',
  'pause.players': 'Jogadores',
  'pause.self': '{name} (você)',
  'pause.language': 'Idioma',
}
export const ja: Table = {
  'pause.title': 'ポーズ',
  'pause.resume': '再開',
  'pause.restart': 'リスタート',
  'pause.sensitivity': 'マウス感度',
  'pause.players': 'プレイヤー',
  'pause.self': '{name}（あなた）',
  'pause.language': '言語',
}
export const ko: Table = {
  'pause.title': '일시정지',
  'pause.resume': '계속하기',
  'pause.restart': '다시 시작',
  'pause.sensitivity': '마우스 감도',
  'pause.players': '플레이어',
  'pause.self': '{name} (나)',
  'pause.language': '언어',
}
export const zh: Table = {
  'pause.title': '暂停',
  'pause.resume': '继续',
  'pause.restart': '重新开始',
  'pause.sensitivity': '鼠标灵敏度',
  'pause.players': '玩家',
  'pause.self': '{name}（你）',
  'pause.language': '语言',
}
export const ar: Table = {
  'pause.title': 'إيقاف مؤقت',
  'pause.resume': 'استئناف',
  'pause.restart': 'إعادة التشغيل',
  'pause.sensitivity': 'حساسية الفأرة',
  'pause.players': 'اللاعبون',
  'pause.self': '{name} (أنت)',
  'pause.language': 'اللغة',
}
