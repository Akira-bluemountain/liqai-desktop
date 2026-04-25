# LiqAI ユーザーガイド (日本語、初心者向け)

このガイドでは、LiqAI を初めて使う方向けに、**インストール → ウォレット接続 → LP 開設 → ボット起動** までを順を追って説明します。

> **重要**: LiqAI は実験段階のソフトウェアです。$1,000-$10,000 程度の少額からお試しください。Stage 1-3 の検証を経て段階的に推奨額が引き上げられます。

---

## 目次

1. [事前準備](#1-事前準備)
2. [インストール (Apple notarization なし対応)](#2-インストール)
3. [初回起動とウォレット接続](#3-初回起動とウォレット接続)
4. [スマートアカウント (SA) への入金](#4-スマートアカウント-sa-への入金)
5. [LP ポジション開設 (Mint LP)](#5-lp-ポジション開設)
6. [セッションキー設定](#6-セッションキー設定)
7. [ボット起動と監視](#7-ボット起動と監視)
8. [パスフレーズの管理](#8-パスフレーズの管理)
9. [ボット停止・LP の引き出し](#9-ボット停止lp-の引き出し)
10. [トラブルシューティング](#10-トラブルシューティング)
11. [FAQ](#11-faq)

---

## 1. 事前準備

### 1.1 必要なもの

- **macOS (Apple Silicon)** — M1/M2/M3/M4 シリーズの Mac
- **MetaMask** (推奨) または WalletConnect 対応ウォレット
  - インストール: <https://metamask.io>
- **メインネット ETH**: 0.03 ETH 以上 (ガス代用)
- **USDC**: $50-200 (LP 元本)
- **24時間 PC 起動環境**: ボットがローカルで動くため、PC が停止するとリバランスが止まります

### 1.2 推奨される運用準備

- **電源接続維持**: ノート PC ならアダプタ接続のまま
- **スリープ防止**: macOS なら `caffeinate -dims` を別ターミナルで実行 (詳細は [§7.3](#73-pc-スリープ防止-必須))
- **インターネット安定**: 切断時はリバランスが遅延

---

## 2. インストール

### 2.1 .dmg ダウンロード

[Releases](https://github.com/Akira-bluemountain/liqai-desktop/releases) から最新の `LiqAI-x.y.z.dmg` をダウンロード。

`checksums.txt` も併せてダウンロードし、ハッシュ検証を推奨:

```bash
shasum -a 256 LiqAI-*.dmg
# 出力ハッシュが checksums.txt の内容と一致することを確認
```

### 2.2 アプリのインストール

1. `.dmg` をダブルクリックでマウント
2. `LiqAI.app` を `/Applications` フォルダにドラッグ & ドロップ
3. `.dmg` をアンマウント

### 2.3 初回起動 (重要: Apple notarization なしの右クリック開放手順)

> 現在 LiqAI は Apple Developer ID 公証 (notarization) を行っていないため、初回起動時に macOS の Gatekeeper でブロックされます。**右クリック開放**で許可してください。

**手順**:

1. Finder で `/Applications` を開く
2. `LiqAI.app` を **右クリック** (Control + クリック) → メニューから **開く**
3. 「開発元を確認できないため開けません」のダイアログが出ても、**もう一度右クリック → 開く** を選ぶ
4. macOS が「本当に開きますか?」と確認 → **開く** をクリック
5. アプリが起動すれば成功

**2回目以降は通常のダブルクリックで起動可能**。

> **「壊れているため開けません」エラーの場合**: ターミナルで以下を実行してから再起動してください:
> ```bash
> xattr -cr /Applications/LiqAI.app
> ```
> これは macOS の隔離属性を削除するコマンドで、未署名アプリの典型的な対処法です。

---

## 3. 初回起動とウォレット接続

### 3.1 LiqAI 起動後の画面

起動すると、以下のような画面が表示されます:

```
+----------------------------------------+
| LiqAI                                  |
+----------------------------------------+
| Connect Wallet                         |
| ...                                    |
+----------------------------------------+
```

> **(スクショ枠: 起動直後の Connect Wallet 画面)**

### 3.2 ウォレット接続

1. **Connect Wallet** をクリック
2. MetaMask の場合: ポップアップが出る → **Connect** をクリック
3. WalletConnect の場合: QR コードが表示される → モバイルウォレットで読み取って承認
4. 接続後、画面右上に **EOA アドレス** (例: `0xAbCd...EfGh`) と **Ethereum Mainnet** が表示される

> **(スクショ枠: ウォレット接続後の状態)**

### 3.3 ネットワーク確認

ウォレット側で **Ethereum Mainnet (chainId 1)** に接続されていることを確認してください。Sepolia / Polygon / Arbitrum 等が選択されていると LiqAI は動きません。

---

## 4. スマートアカウント (SA) への入金

LiqAI は **ZeroDev Kernel スマートアカウント (SA)** をあなたの EOA から決定的に導出します。LP ポジションは SA が保有します。

### 4.1 SA アドレスの確認

ウォレット接続後、画面のどこかに **Smart Account: `0x...`** が表示されます。これがあなたの SA アドレスです。

> **(スクショ枠: SA アドレス表示箇所)**

### 4.2 入金

このアドレスに **ETH と USDC** を送金:

| 通貨 | 推奨額 | 用途 |
|---|---|---|
| ETH | 0.03 ETH 以上 | ガス代 (mint + 数回のリバランス分) |
| USDC | $50-200 | LP 元本 (Stage 1 推奨額) |

**送金方法**:
- 取引所 (Binance / Coinbase 等) から直接 SA アドレスへ
- または EOA から SA へ MetaMask 経由で送金

> **注意**: SA アドレスは EOA とは別アドレスです。**EOA に送金しないでください**。

### 4.3 残高確認

LiqAI 画面の **Balances** セクションで:
- ETH balance: 0.03 ETH 以上
- USDC balance: $50 以上

になっていることを確認します。

---

## 5. LP ポジション開設

### 5.1 Position size 入力

**Position size preview** 入力欄に USDC 額を入力 (例: `50` で $50 相当の LP を開設)。

> **(スクショ枠: Position size preview 入力箇所)**

### 5.2 推奨レンジの確認

AI が以下を計算して表示します:

- Range width (例: ±10% around spot)
- Volatility (annualised)
- AI confidence (0-100)
- Expected APR (推定値)
- Tick range (例: `[197720, 199770]`)

> **(スクショ枠: AI レンジ計算結果)**

### 5.3 Mint LP 実行

**Mint LP position** ボタンをクリック → MetaMask が署名要求 → **Confirm**。

- 数十秒後にトランザクション確定
- 確定後、**LP NFT tokenId** + **liquidity** が表示される
- Etherscan へのリンクも表示される

> **(スクショ枠: Mint 完了後の "Position minted" モーダル)**

これで LP ポジションが SA 名義で作成されました。**現時点ではまだ自動運用は始まっていません** — 次のステップでセッションキーを設定します。

---

## 6. セッションキー設定

セッションキーは、ボットが毎回ウォレット署名を求めずに済むように、**スコープ限定された一時的な署名鍵** をスマートアカウントに登録する仕組みです。

### 6.1 Session Key Panel を開く

**Session Key Panel** (Sidebar / Tab どこか) を開きます。

> **(スクショ枠: Session Key Panel 初期画面)**

### 6.2 Generate Session Key

**Generate Session Key** ボタンをクリック → 画面に以下のような Policy preview が表示されます:

| 項目 | 値 |
|---|---|
| Target | Uniswap V3 NPM + USDC + WETH |
| Allowed functions | mint / decreaseLiquidity / collect / approve |
| Approve cap | 50,000 USDC / 20 WETH |
| Recipient pin | あなたの SA アドレス |
| Rate limit | max 10 executions / 24h |
| Expiry | 30 days (auto) |

> **(スクショ枠: Generated session key + Policy preview)**

### 6.3 パスフレーズ設定 (重要)

**Install on Smart Account** をクリック → パスフレーズダイアログが出ます。

**強度要件 (60-bit エントロピー以上)**:
- Diceware 方式: 5 単語以上 (例: `correct horse battery staple quantum`)
- または 14 文字以上の混在 (大文字+小文字+数字+記号、例: `Apple7#Kimono$2026!`)

> **重要 — パスフレーズ管理**:
> - パスフレーズはローカルでセッションキー秘密鍵を AES-GCM 暗号化する鍵です
> - **LiqAI 側にも保存されません**。あなたが忘れるとセッションキーは復号できなくなります
> - パスワードマネージャー (1Password 等) に保存することを強く推奨

弱いパスフレーズを入力すると赤文字で `Passphrase rejected: ...` が表示されます (これは仕様)。

### 6.4 EIP-712 署名

パスフレーズ確認後、**Install** クリック → MetaMask が EIP-712 署名要求 → **Sign**。

- これは **オフチェイン署名** で、ガス代はかかりません
- 実際のオンチェイン install は最初のリバランス時に行われます (lazy install)

> **(スクショ枠: MetaMask EIP-712 署名ポップアップ)**

### 6.5 Install 完了確認

成功すると Session Key Panel に **Installed Session Keys** リストに新しいエントリが追加されます:

```
0x... (新しい session key address)
  Installed: <日付>
  Expires:   <日付>
  Rate:      10/24h
```

> **(スクショ枠: Installed session keys リスト)**

---

## 7. ボット起動と監視

### 7.1 Bot Panel を開く

**Bot Panel** (Sidebar / Tab) を開きます。

> **(スクショ枠: Bot Panel 初期 STOPPED 状態)**

### 7.2 パスフレーズ入力 + Start Bot

1. パスフレーズダイアログが出る → §6.3 で設定したパスフレーズを入力
2. **Start Bot** クリック
3. 画面が `STOPPED` → `RUNNING` に変化

### 7.3 PC スリープ防止 (必須)

別ターミナルで以下を実行:

```bash
caffeinate -dims
```

- `-d` ディスプレイスリープ防止
- `-i` アイドルスリープ防止
- `-m` ディスクスリープ防止
- `-s` システムスリープ防止
- 終了するときは `Ctrl+C`

代替案: **System Settings → Lock Screen → "Prevent automatic sleeping when display is off"** を有効化

### 7.4 First evaluation tick の確認

Bot は起動 5 秒以内に最初の evaluation を発火し、以降 5 分間隔で動作します。

Bot Panel で:
- **Last evaluation**: タイムスタンプ更新
- **Next evaluation**: ~5 min
- **Range status**: in range / out of range
- **Outcome**: idle / no_trigger / triggered / error

> **(スクショ枠: Bot RUNNING 中の状態)**

### 7.5 リバランス発生時の動作

ETH 価格が tick range を抜けると自動リバランス:

1. **Phase 1**: 既存 LP 解除 (decreaseLiquidity + collect)
2. **Phase 2**: 新レンジで mint
3. Bot Panel に履歴追加 + Etherscan tx へのリンク

毎回 ETH ガスが消費されます (mainnet で 1 リバランス ≈ $5-15 程度、ガス価格次第)。

---

## 8. パスフレーズの管理

### 8.1 パスフレーズの役割

- **セッションキー秘密鍵を AES-GCM 暗号化**するための鍵
- **PBKDF2-SHA256 (200,000 iterations)** でキー導出
- **LiqAI 側にもどこにも保存されません**。あなたの記憶 + パスワードマネージャーのみに存在

### 8.2 紛失時のリカバリ

パスフレーズを忘れた場合:

1. **暗号化されたセッションキー秘密鍵は復号不可能**
2. ボットは動かなくなる
3. **LP NFT 自体は EOA → SA → NFT の所有関係で安全** (EOA で sudo 権限を持つので、署名すれば回収可能)
4. リカバリ手順:
   - LiqAI の **Session Key Panel** で該当キーを **Revoke**
   - 新しいパスフレーズで **Generate Session Key** + **Install** を再実行
   - LP は無事

### 8.3 パスフレーズ漏洩時の対処

- セッションキー秘密鍵が復号される可能性
- ただしオンチェイン側 (CallPolicy) で:
  - 24h 内 10 回までの rate limit
  - 30 日後の自動失効
  - 受取アドレス = SA に固定 (attacker 宛 mint/collect は revert)
- 即座に対処すべき:
  1. Bot Panel で **Stop Bot**
  2. Session Key Panel で該当キーを **Revoke** (ローカル ciphertext erase)
  3. 心配なら EOA 経由で LP を **Withdraw** (LP 破棄)

---

## 9. ボット停止・LP の引き出し

### 9.1 ボット停止

1. Bot Panel → **Stop Bot**
2. `caffeinate` ターミナルで Ctrl+C

### 9.2 LP の引き出し (Withdraw)

1. Positions Dashboard で該当 LP の **Withdraw** をクリック
2. MetaMask 署名 → 数十秒後に確定
3. LP NFT は破棄され、USDC + WETH が SA に戻る
4. SA から EOA への送金は通常の MetaMask 操作で可能

---

## 10. トラブルシューティング

### Symptom: 「LiqAI.app は壊れているため開けません」

**対処**: ターミナルで `xattr -cr /Applications/LiqAI.app` を実行してから再度右クリック開放。

### Symptom: ウォレット接続できない

**対処**:
- MetaMask が Mainnet に接続されているか確認
- LiqAI を再起動 (Cmd+Q → 再起動)
- WalletConnect の場合は別端末で QR を読み直す

### Symptom: Generate Session Key で `Smart Account address not yet derived` 赤文字

**対処**: ウォレット接続が不完全な可能性。
- ウォレットを切断 → 再接続
- LiqAI 完全再起動 (Cmd+Q + 再起動)
- それでも再現する場合は GitHub Issues で報告 (詳細は [SECURITY.md](../SECURITY.md))

### Symptom: Install で `Passphrase rejected: ...`

**対処**: パスフレーズが弱すぎます。Diceware 5 単語以上、または 14 文字以上の混在に変更してください。

### Symptom: Bot 起動後 5 分経っても evaluation log が出ない

**対処**:
- インターネット接続確認
- LiqAI 再起動
- アラート: Tauri dev console (開発モードのみ) で error log 確認

### Symptom: リバランス gas が異常に高い (1 回 $30+)

**対処**:
- イーサリアム mainnet が混雑時です
- Bot が自動的にスキップする gas-aware gate を実装済み (position 価値の 2% を超える gas は no-trigger)
- 数時間後に再評価されます

---

## 11. FAQ

### Q1. LiqAI は私の資金を勝手に動かせますか?

**A**: いいえ。LiqAI は秘密鍵を一切持ちません。

- LP ポジションはあなたの **スマートアカウント (SA)** が保有
- SA は **あなたの EOA からのみ** sudo 操作可能 (MetaMask 署名必須)
- セッションキーは限定的な権限 (NPM の特定関数のみ呼び出し可) で、**受取アドレスは SA に固定** されているため、attacker の手に渡っても資金は SA から出られません

詳細は [SECURITY.md](../SECURITY.md) を参照。

### Q2. なぜ 24/7 PC 起動が必要なのですか?

**A**: ボット自動運用ロジック (リバランス判定 + 実行) はローカル PC 上で動いています。LiqAI 側のサーバーは存在しないため、PC が止まるとリバランスも止まります。

将来的には Gelato Automate 等のオンチェイン automation サービスとの統合を予定 (v0.2 以降)。

### Q3. ガス代はどれくらい?

**A**: イーサリアム mainnet のガス価格次第ですが、目安:

- Mint LP: $5-15
- リバランス 1 回: $5-15 (Phase 1 + Phase 2 合計)
- 1 ヶ月の運用 (リバランス 5-10 回想定): $25-150

少額 ($50-100) の LP では gas drag が APR を上回ることが多く、$1,000 以上での運用を推奨します。

### Q4. 対応チェーンは?

**A**: 現在 **Ethereum Mainnet のみ**。Base / Arbitrum 対応は v0.2 で予定しています。

### Q5. 報酬や手数料は?

**A**: LiqAI は完全無償 (オープンソース) です。手数料は徴収しません。

### Q6. Stage 1 / 2 / 3 とは?

**A**: 段階的検証ロードマップ:

- **Stage 1**: $50 LP × 24h 自動運用 + 攻撃シミュレーション 3 件
- **Stage 2**: $100 LP × 24h
- **Stage 3**: $200 LP × 24h
- 各 Stage PASS で次 Stage に進行、Stage 3 PASS で「通常運用 ($1k-$10k 推奨)」に正式移行

詳細は内部運用ドキュメント (招待制 50 名のテスター向け) で共有しています。

### Q7. 脆弱性を見つけたら?

**A**: [SECURITY.md](../SECURITY.md) の窓口に直接連絡してください。public な GitHub Issues ではなく、責任ある開示 (responsible disclosure) を希望します。

---

## 関連ドキュメント

- **[../README.md](../README.md)** — トップページ概要
- **[architecture-v2.md](architecture-v2.md)** — 技術アーキテクチャ
- **[dev-setup.md](dev-setup.md)** — 開発者向けセットアップ
- **[../SECURITY.md](../SECURITY.md)** — 脆弱性報告窓口

質問は GitHub Discussions または LINE Official Account (招待者向け) でお気軽にどうぞ。
