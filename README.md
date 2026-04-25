# LiqAI

> Uniswap V3 USDC/WETH LP ポジションを AI で自動管理するデスクトップアプリ

**LiqAI** は、あなたのウォレット内資産で Uniswap V3 LP ポジションを自動管理する非カストディアル (non-custodial) なデスクトップアプリです。LiqAI 側はあなたの秘密鍵を一切預かりません。

---

## ⚠️ 注意事項

- **実験段階のソフトウェアです**。$1,000-$10,000 程度の少額運用を推奨します。
- **メインネット (Ethereum) のみ対応**。Base / Arbitrum 対応は将来予定です。
- **24/7 PC 起動が必要**。Bot がローカルで動くため、PC が停止するとリバランスが止まります。
- **すべて自己責任**。スマートコントラクトリスク、価格変動リスク、ガス代コストを理解の上ご利用ください。

---

## できること

- Uniswap V3 USDC/WETH 0.05% プールへの LP ポジション開設
- AI 推奨レンジでの自動リバランス (24時間ボット運用)
- セッションキー方式により、毎回ウォレット署名を求められない
- ローカル SQLite に全状態保存、外部サーバー一切なし

---

## 必要なもの

| 項目 | 内容 |
|---|---|
| OS | macOS (Apple Silicon) |
| ウォレット | MetaMask または WalletConnect 対応のウォレット |
| 初期資金 (推奨) | mainnet ETH ~0.03 ETH (ガス用) + USDC $50-200 |
| インターネット | 安定接続 + 24/7 PC 起動環境 |

---

## クイックスタート (4 ステップ)

詳細手順は **[docs/USER-GUIDE.md](docs/USER-GUIDE.md)** をご覧ください。

### 1. インストール

[Releases](https://github.com/Akira-bluemountain/liqai-desktop/releases) から最新の `.dmg` をダウンロードしてインストール。

> **初回起動時に「開発元未確認」エラーが出る場合**: `LiqAI.app` を **右クリック → "開く"** で起動を許可できます (詳細は [USER-GUIDE](docs/USER-GUIDE.md))。

### 2. ウォレット接続

LiqAI を起動 → **Connect Wallet** → MetaMask または WalletConnect でメインネット接続。

### 3. 資金入金 + LP ポジション作成

- スマートアカウント (SA) アドレスが画面に表示される
- そのアドレスに ETH と USDC を送金
- **Mint LP** ボタンで AI 推奨レンジの LP ポジションを開設

### 4. セッションキー設定 + ボット起動

- **Generate Session Key** → パスフレーズ設定 (Diceware 5+ 単語推奨)
- **Install on Smart Account** → ウォレットで EIP-712 署名 (オフチェイン、ガスなし)
- **Start Bot** → 24/7 自動運用開始

---

## ドキュメント

- **[docs/USER-GUIDE.md](docs/USER-GUIDE.md)** — 初心者向け詳細手順 (スクショ付き)
- **[docs/architecture-v2.md](docs/architecture-v2.md)** — 技術アーキテクチャ
- **[docs/dev-setup.md](docs/dev-setup.md)** — コントリビューター向け開発環境構築
- **[SECURITY.md](SECURITY.md)** — 脆弱性報告窓口

---

## ライセンス

[MIT License](LICENSE) — Copyright (c) 2026 Akira-bluemountain

---

# English (short)

**LiqAI** is a non-custodial desktop app for managing Uniswap V3 LP positions on Ethereum mainnet using session keys (ZeroDev Kernel + ERC-4337). Funds and signing keys never leave your wallet.

- **Status**: experimental beta. Recommended position size: $1,000-$10,000.
- **Chain**: Ethereum mainnet only. Pool: USDC/WETH 0.05%.
- **Operation**: requires 24/7 PC uptime for the bot loop.

See [docs/USER-GUIDE.md](docs/USER-GUIDE.md) for installation and usage. Vulnerability disclosures: [SECURITY.md](SECURITY.md).

License: [MIT](LICENSE).
