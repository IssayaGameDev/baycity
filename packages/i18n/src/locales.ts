/**
 * UI string tables. **English is the source of truth** — its keys are the `TranslationKey`
 * type, so a typo or an unknown key fails typecheck; other locales are partial and fall back
 * to English at lookup. Values use `{param}` placeholders for interpolation.
 *
 * The non-English strings are seeded translations of standard, short UI terms — accurate for
 * these but flag for a native-speaker review before shipping. CJK (ja/ko/zh) render via the
 * device fonts; `ar` is RTL (the pause layout mirrors; slider fill/list rows are still LTR).
 */
export const en = {
  'pause.title': 'Paused',
  'pause.resume': 'Resume',
  'pause.restart': 'Restart',
  'pause.sensitivity': 'Mouse sensitivity',
  'pause.players': 'Players',
  'pause.self': '{name} (you)',
  'pause.language': 'Language',
  'status.connecting': 'Connecting…',
  'status.room': 'Room {room}',
  'status.offline': 'Offline',
  'hint.controls': 'Move: WASD · Jump: Space · Look: mouse · Menu: Esc',
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
  'status.connecting': 'Conectando…',
  'status.room': 'Sala {room}',
  'status.offline': 'Sin conexión',
  'hint.controls': 'Mover: WASD · Saltar: Espacio · Mirar: ratón · Menú: Esc',
}
export const fr: Table = {
  'pause.title': 'Pause',
  'pause.resume': 'Reprendre',
  'pause.restart': 'Recommencer',
  'pause.sensitivity': 'Sensibilité de la souris',
  'pause.players': 'Joueurs',
  'pause.self': '{name} (toi)',
  'pause.language': 'Langue',
  'status.connecting': 'Connexion…',
  'status.room': 'Salon {room}',
  'status.offline': 'Hors ligne',
  'hint.controls': 'Déplacer : WASD · Sauter : Espace · Regarder : souris · Menu : Échap',
}
export const nl: Table = {
  'pause.title': 'Gepauzeerd',
  'pause.resume': 'Hervatten',
  'pause.restart': 'Opnieuw',
  'pause.sensitivity': 'Muisgevoeligheid',
  'pause.players': 'Spelers',
  'pause.self': '{name} (jij)',
  'pause.language': 'Taal',
  'status.connecting': 'Verbinden…',
  'status.room': 'Kamer {room}',
  'status.offline': 'Offline',
  'hint.controls': 'Bewegen: WASD · Springen: Spatie · Kijken: muis · Menu: Esc',
}
export const pt: Table = {
  'pause.title': 'Pausado',
  'pause.resume': 'Continuar',
  'pause.restart': 'Reiniciar',
  'pause.sensitivity': 'Sensibilidade do mouse',
  'pause.players': 'Jogadores',
  'pause.self': '{name} (você)',
  'pause.language': 'Idioma',
  'status.connecting': 'Conectando…',
  'status.room': 'Sala {room}',
  'status.offline': 'Offline',
  'hint.controls': 'Mover: WASD · Pular: Espaço · Olhar: mouse · Menu: Esc',
}
export const ja: Table = {
  'pause.title': 'ポーズ',
  'pause.resume': '再開',
  'pause.restart': 'リスタート',
  'pause.sensitivity': 'マウス感度',
  'pause.players': 'プレイヤー',
  'pause.self': '{name}（あなた）',
  'pause.language': '言語',
  'status.connecting': '接続中…',
  'status.room': 'ルーム {room}',
  'status.offline': 'オフライン',
  'hint.controls': '移動: WASD · ジャンプ: スペース · 視点: マウス · メニュー: Esc',
}
export const ko: Table = {
  'pause.title': '일시정지',
  'pause.resume': '계속하기',
  'pause.restart': '다시 시작',
  'pause.sensitivity': '마우스 감도',
  'pause.players': '플레이어',
  'pause.self': '{name} (나)',
  'pause.language': '언어',
  'status.connecting': '연결 중…',
  'status.room': '방 {room}',
  'status.offline': '오프라인',
  'hint.controls': '이동: WASD · 점프: 스페이스 · 시점: 마우스 · 메뉴: Esc',
}
export const zh: Table = {
  'pause.title': '暂停',
  'pause.resume': '继续',
  'pause.restart': '重新开始',
  'pause.sensitivity': '鼠标灵敏度',
  'pause.players': '玩家',
  'pause.self': '{name}（你）',
  'pause.language': '语言',
  'status.connecting': '连接中…',
  'status.room': '房间 {room}',
  'status.offline': '离线',
  'hint.controls': '移动: WASD · 跳跃: 空格 · 视角: 鼠标 · 菜单: Esc',
}
export const ar: Table = {
  'pause.title': 'إيقاف مؤقت',
  'pause.resume': 'استئناف',
  'pause.restart': 'إعادة التشغيل',
  'pause.sensitivity': 'حساسية الفأرة',
  'pause.players': 'اللاعبون',
  'pause.self': '{name} (أنت)',
  'pause.language': 'اللغة',
  'status.connecting': 'جارٍ الاتصال…',
  'status.room': 'غرفة {room}',
  'status.offline': 'غير متصل',
  'hint.controls': 'التحرك: WASD · القفز: مسافة · النظر: الفأرة · القائمة: Esc',
}
