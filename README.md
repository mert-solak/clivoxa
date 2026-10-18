# Clivoxa

Clivoxa, Claude (Code ve Desktop) ile Codex (CLI ve Desktop) arasında yerel bir MCP köprüsüdür.
Claude'dan Codex'e, Codex'ten Claude'a danışılabilir veya iş verilebilir.

Clivoxa, kurulu CLI'ları kullanıcının kendi girişiyle çalıştırır (`ask_codex` için `codex exec`,
`ask_claude` için `claude -p`); istemler ve okunan dosyalar ilgili sağlayıcıya gider ve Anthropic
ile OpenAI kullanım koşullarına uymak kullanıcının sorumluluğundadır.

Clivoxa bilgisayarda çalışan uygulamalar arasında köprü kurar; bu yüzden bulutta çalışan
ortamlarda kullanılamaz. ChatGPT sohbeti, web'deki Claude Code ve Codex bulut görevleri bu
ortamlardandır.

> Clivoxa bağımsız bir açık kaynak projedir; Anthropic veya OpenAI ile bağlantılı değildir.

## Gereksinimler

- Node.js **22+** ve Git.
- Danışılacak tarafın CLI'ı kurulu ve o CLI'da giriş yapılmış olmalıdır:
  - Claude'dan Codex'e danışmak için **Codex CLI 0.162.1+**,
  - Codex'ten Claude'a danışmak için **Claude Code 2.1.300+**.
- Linux'ta Claude'a dosya erişimi için `bubblewrap` (`bwrap`) ve `socat` gerekir.

**Windows'ta:**

- Bu sürümde Claude ve Codex'e dosya erişimi verilemez; dosyasız danışma kullanılabilir.
- PowerShell'in kısıtlı dil kipi (Constrained Language Mode) desteklenmez.
- Claude veya Codex uygulaması kapatılırsa çalışan iş yarıda kalabilir.

## Kurulum

1. Claude ve Codex uygulamaları kapatılır.
2. Kurulum komutu çalıştırılır:

   ```sh
   npx -y github:mert-solak/clivoxa setup
   ```

3. Kurulum bitince uygulamalar yeniden açılır.

Kurulum, bulunan Claude ve Codex uygulamalarına Clivoxa'yı ekler; diğer ayarlara dokunmaz ve
değiştirdiği dosyaları önce `~/.clivoxa/backups/` altına yedekler.

İsteğe bağlı seçenekler:

| Seçenek | Açıklama |
|---|---|
| `setup claude-code` / `claude-desktop` / `codex` | Clivoxa yalnız seçilen uygulamaya eklenir (`codex`: CLI ve Desktop) |
| `setup --max-access read` | Yazma tamamen kapatılır; ajan yalnız okuyabilir |

## Kullanım

Sohbette doğal dille istekte bulunulur:

- "Bu tasarımı Codex'e de sor."
- "Bu iki çözümden hangisi daha iyi, Codex hakem olsun."
- "Codex bu klasördeki değişiklikleri incelesin."
- "Codex şu testleri yazsın."

Codex'te de aynı şekilde "Claude'a sor" denebilir. Uzun süren bir işin sonucu daha sonra
istenebilir, çalışan bir iş durdurulabilir. Sonuçtaki oturum bilgisiyle konuşmaya kendi CLI'da da
devam edilebilir: `codex resume <id>` ya da işin yapıldığı klasörde `claude --resume <id>`.

### Dosya erişimi

Ajan varsayılan olarak yalnız okur; klasör verilmezse hiçbir dosya görmez. Klasör verildiğinde
klasör dışındaki gizli olmayan dosyaları da okuyabilir (bilinen giriş bilgisi ve gizli dosya
yolları engellenir). Yazma yalnız değişiklik istendiğinde yapılır.

### İsteğe bağlı skill'ler

GitHub deposundaki `skills/` klasöründe bulunan iki skill, ajana ne zaman danışacağını ve
sonucu nasıl sunacağını anlatır; araçlar onlarsız da çalışır. Kullanmak için ilgili klasör hedefe kopyalanır:

| Uygulama | Klasör | Hedef |
|---|---|---|
| Claude Code | `skills/clivoxa-codex-ile-calis` | `~/.claude/skills/` |
| Codex | `skills/clivoxa-claude-ile-calis` | `~/.agents/skills/` |

## Güncelleme ve kaldırma

Güncellemek ya da kurulumu onarmak için kurulum komutu yeniden çalıştırılır.

Kaldırmak için:

```sh
npx -y github:mert-solak/clivoxa uninstall
```

Kaldırma, yalnız kurulumun eklediği ve sonradan değiştirilmemiş kayıtları siler. İş kayıtları ve
yedekler `~/.clivoxa/` altında kalır; istenirse bu klasör silinebilir.

## Sorun giderme

```sh
npx -y github:mert-solak/clivoxa doctor
npx -y github:mert-solak/clivoxa doctor --verify
```

`doctor` CLI'ların bulunup bulunmadığını ve sandbox denetiminin sonucunu gösterir; `--verify` bu
denetimi ücretsiz olarak yeniden çalıştırır.

## Lisans

MIT. Bkz. [LICENSE](LICENSE).
