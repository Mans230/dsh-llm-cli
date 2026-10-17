# نتيجة تنفيذ خطة الإصلاح

هذا سجل الجولة المحلية الأولى. انظر [RELEASE-CHECK.md](RELEASE-CHECK.md)
لنتائج جولة ما قبل الرفع اللاحقة، ومنها نجاح OpenCode beam-free داخل خدمة
DSH وتصحيح محاسبة كاش Codex.

التاريخ: 2026-10-17. التغييرات محلية على `main` فوق
`1dba984821d93ded4b09340abfe5b36fdd867128`، دون commit أو push جديد.
قائمة التنفيذ: [AUDIT-PLAN.md](AUDIT-PLAN.md).

## الأحكام والأدلة

هذه الجولة تختبر البلاغات التسعة مع إعادة اختبارات التدقيق الموجودة؛ لا تدّعي
إثبات كل احتمال في التطبيق الكامل.

| المرحلة | الحكم | الأمر والدليل |
|---|---|---|
| 0: الجرد | PASS | `node test/_audit.mjs inventory`: Node 24.21.0؛ OpenCode 2.0.32، Grok 1.0.62، Codex 0.163.0؛ مسارات التشغيل محلولة بلا shell. |
| 1: السلامة الثابتة | PASS | `node --check index.js` و`client.js` و`test/_audit.mjs`، `git diff --check`، `npm pack --dry-run --json`: الحزمة تضم الملفات السبعة المقصودة فقط. عقد manifest/exports نجح ضمن contract.test. |
| 2: الاختبارات | PASS | `npm test`: 13/13. `node test/_audit.mjs suites`: 13/13 لكل من empty-cache وhost-cache وmaster-default. `mutations`: اكتشاف 31 طفرة، تغطي جميع مجموعات الاختبار الـ13. |
| 3: الوظائف | UNVERIFIED جزئيًا | `probes` و`real-capabilities` واختبار خدمة DSH الحقيقية نجحت في الأجزاء المذكورة أدناه؛ كتابة Codex فشلت، وOpenCode رفض الاستدلال بـ429. التطبيق الكامل ودورة تنفيذ الأدوات بصلاحيات مستخدم حقيقي غير مُثبتين. |
| 4: بيانات المضيف | PASS للقراءة والعرض | `snapshot` و`real-sanity`: مقارنة مستقلة لملفات Grok/Codex تطابق القرّاء. الاستدلال الحقيقي موثّق منفصلًا. |
| 5: المتانة | UNVERIFIED جزئيًا | `probes` واختبارات الإخفاق/الإلغاء/الصور نجحت؛ HTML بعرض390 دون overflow أو NaN/undefined. snapshot المتصفح الحي انتهى بمهلة مرتين؛ قتل جميع العمليات المتفرعة غير مُثبت. |
| 6: المنشور وCI | UNVERIFIED للتغييرات المحلية | `clone`: origin/main عند 1dba984 نجح11/11. CI لذلك commit نجح على20/22/24. التغييرات المحلية الجديدة لم تُنشر ولم تعمل في CI. |

الأدلة الخام في
[مجلد الأدلة](C:/Users/Administrator/AppData/Local/Temp/2/dsh-three-step-plan-20261017):
[الاختبارات](C:/Users/Administrator/AppData/Local/Temp/2/dsh-three-step-plan-20261017/npm-test.log)،
[المتغيرات](C:/Users/Administrator/AppData/Local/Temp/2/dsh-three-step-plan-20261017/suites-console.log)،
[الطفرات النهائية](C:/Users/Administrator/AppData/Local/Temp/2/dsh-three-step-plan-20261017/mutations-console.log)،
[الفحوص الوظيفية](C:/Users/Administrator/AppData/Local/Temp/2/dsh-three-step-plan-20261017/probes-console.log)،
[التنفيذ الحقيقي](C:/Users/Administrator/AppData/Local/Temp/2/dsh-three-step-plan-20261017/real-capabilities.log)،
[خدمة DSH](C:/Users/Administrator/AppData/Local/Temp/2/dsh-three-step-plan-20261017/runtime.log).

## البلاغات التسعة: ما تغيّر وما ثبت

1. **حدود OpenCode** — إعادة الإنتاج السابقة: اختيار موديلات مختلفة كان يعود
   إلى200000 عند غياب إعداد يدوي. [index.js:1469](index.js#L1469) يقرأ الآن
   `api GET /api/model`، و[index.js:1583](index.js#L1583) يطبق السياسة المطلوبة.
   الكتالوج الحقيقي هنا25 موديلًا، وليس96. القيم المنفذة:
   `opencode/beam-free`:1048576/131072؛
   `opencode/deepseek-v4.1-flash-free`:200000/32000؛
   `opencode/deepseek-v4.1-flash`:500000/384000، بعد سقف من أصل1000000.
   لا نرفع حدًا أصليًا أصغر. model-limits.test يحمي ذلك؛ إزالة Math.min في
   النسخة التجريبية فشلت: المتوقع500000، الفعلي1000000.

2. **قدم بيانات Codex** — إعادة الإنتاج: تعديل rollout ثم الضغط على Refresh
   أثناء TTL كان يعيد البيانات المخزنة. invalidateCaches و`force=1` يعيدان
   القراءة، بما فيها كاش الملفات ذات الحجم وmtime غير المتغيرين.
   [index.js:660](index.js#L660) يقبل quota-only؛ زمن الملاحظة مأخوذ من حدث
   الحصة نفسه. الواجهتان تعرضان recorded/stale بدل الادعاء بقراءة لحظية.
   usage.test وdashboard.test وclient.test تحمي ذلك؛ تعطيل force أو إبقاء
   rolloutCache فشل في الطفرات. **جلب حصة الحساب الحية دون تشغيل Codex لم
   يُنفذ**؛ المصدر ما زال ملفات CLI، والقيمة القديمة معلّمة بوضوح.

3. **cwd موحّد** — إعادة الإنتاج: جلستان في مجلدين كانتا تشغّلان الطفل في
   config.cwd. [index.js:1806](index.js#L1806) يستخدم session.header.cwd، مع
   resolveCwd اختياري. الجلسة المجهولة تفشل بدل التحول الصامت للمجلد العام.
   execution.test شغّل طفلين بالتوازي وكتب ملفين منفصلين. إعادة global cwd
   في النسخة التجريبية فشلت عند فحص مساحة الجلسة الأولى.

4. **Codex read-only** — [index.js:154](index.js#L154) يقبل الآن
   `providers.codex.sandbox: workspace-write` بدل hardcoding لا يمكن تجاوزه.
   الافتراضي يظل read-only. اختبارات execution تثبت وسيطات البناء القصير
   وبناء transcript-file. **الكتابة الحقيقية فشلت على هذا المضيف مرتين**:
   تم تمرير `-s workspace-write` لكن الرد والسجل أظهرا read-only؛ الملف لم
   يوجد. سبب تجاهل CLI لهذه السياسة غير محسوم، ولا يُحسب هذا نجاحًا في التحرير.
   لم نستخدم تجاوز sandbox. مرجع الإعداد:
   [وثائق OpenAI الرسمية](https://learn.chatgpt.com/docs/agent-approvals-security).

5. **البث** — execution.test يلتقط FIRST بينما الطفل ما زال يعمل، ويتأكد أن
   ملف علامة خروجه لم يُكتب بعد، ثم يثبت خروجه لاحقًا. المسار كان يملك بثًا
   تدريجيًا بالفعل؛ هذا البلاغ لم يتكرر في الكود الحالي. ردود relay التي
   تبدأ ببروتوكول الأدوات تُجمع حتى يمكن التحقق منها قبل تسليمها للمضيف.

6. **أدوات DSH** — [index.js:1028](index.js#L1028) يرسل schemas للأدوات
   المعروضة ويحوّل طلب JSON صالحًا إلى tool-call-delta/block-end وfinish
   من نوع tool-calls. contentToText يحفظ ارتباط النتيجة بمعرّف الطلب.
   capabilities.test نفّذ sum ثم أعاد RESULT_5. الاختبار الحقيقي مع Codex
   وGrok طلب audit_echo وأعاد REAL_HOST_RESULT_bridge. تعطيل relay فشل
   في الطفرات. هذه وساطة تعتمد على التزام الموديل بالبروتوكول؛ تنفيذ الأدوات
   وصلاحياتها يبقيان للمضيف، وليست قناة MCP أصلية إلى داخل CLI.

7. **الصور** — [index.js:1873](index.js#L1873) يقرأ البايتات من خدمة attachments،
   ويمررها فعليًا عبر flags أو ACP. capabilities.test يفحص البايتات والتنظيف
   عند النجاح وفشل البناء، ورفض غياب الخدمة، وفشل خروج ACP المبكر.
   حذف التنظيف فشل في الطفرات. Codex وGrok وصفا صورة PNG حمراء مولدة محليًا
   بكلمة Red؛ OpenCode رفض429، لذلك نجاح رؤيته الحية غير مُثبت.

8. **إسقاط التعليمات** — [index.js:3493](index.js#L3493) يجعل تمرير تعليمات
   system/developer هو الافتراضي، مع false لإيقافه. execution.test يثبت وصول
   sentinel ويثبت opt-out. الرجوع إلى الافتراضي القديم فشل في الطفرات.
   التسليم عبر transcript لا يثبت أن كل موديل سيلتزم بالتعليمات دائمًا.

9. **Grok غائب** — لم يتكرر على هذا الجهاز: النسخة1.0.62 مثبتة، واكتشاف
   الموديلات أعاد grok-4.7 وgrok-4.7-build-fast وgrok-4.6 وgrok-4.5.
   الصورة ودورة الأداة نجحتا فعليًا. لا يوجد تثبيت عالمي جديد ضمن هذه الجولة.

## فحوص إضافية وملاحظات الاختبارات

- خدمة `LlmService` المنشورة من @deepseek-ai/dsh-llm@0.0.1-rc.1 مع
  Cordis4.0.5 حمّلت الإضافة، سلّمت REAL_DSH_OK، ثم ألغت المسار عند disposal.
  ملف smoke المنفّذ خارج المستودع موجود في مجلد temp/dsh-runtime-verification-20261017.
  هذا يثبت خدمة المضيف، وليس جلسة كاملة داخل تطبيق DSH Web المنشور.
- فحوص HTTP الفعلية، escaping، التوكن، انتهاء المهلة، أقفال ledger والتحديث
  موجودة في probes-console.log، وكل14 فحصًا أعاد PASS.
- HTML البديل: width390، scrollWidth390، charts3، tables7، invalid=false،
  snapshot=true. التفاعل الحي غير مُثبت بسبب مهلة preview_snapshot مرتين.
- الاختبارات أظهرت أخطاء في إعداد الاختبار أثناء التطوير: موضع -s كان مثبتًا
  خطأ، وcwd الخاص بـACP كان يُفحص في session/prompt بدل session/new، وكتابتان
  متساويتان قد تشتركان في mtime. صُححت هذه الافتراضات، ثم أضيف اختبار مستقل
  متعمد لتساوي mtime والحجم. لم تُحذف متطلبات الإنتاج لتمريرها.
- طفرة حذف فحص الإلغاء الأول مرّت بسبب الفحص الثاني الجديد؛ أضيف تأكيد عدم
  استدعاء محلل مساحة العمل لطلب ملغى مسبقًا. آخر تشغيل اكتشف31/31 طفرة.

الأرقام في snapshot المنفّذ: Grok117453 توكنًا و$0.225102؛ Codex59341393
توكنًا وحصة مسجلة53%/8%، وتكلفته المعروضة شرطة لأنه لا ينشرها؛
OpenCode381104163 توكنًا و$4.419726469 و2768 خطوة. real-sanity أعاد حساب
ملفات Grok/Codex بصورة مستقلة وتطابق مع القرّاء. هذه الأرقام تخص وقت
اللقطة؛ اختبارات CLI الحقيقية تنشئ سجلاته الخاصة وقد تزيد الإجماليات.

## الكود المحذوف والواجهات المحفوظة

لم تُحذف exports أو hooks أو wire fields باعتبارها ميتة. source-scan نفذ
`rg` في index.js وclient.js وtest وREADME وCHANGELOG. أمثلة عدادات مراجع
client: Panel8، StatCard9، Gauge5، LlmCliPage5؛ setters:
setState4، setTick4، setAuto2، setDays2، setUpdate7. هذه مراجع نصية وليست
برهان وصول شامل وقت التشغيل. بقيت providerRetryPolicy/imageRequestPricing/
prepareCall كواجهات للمضيف، وcapabilities.rateLimits/perStep كحقول استجابة.
تحليل كل prop والثوابت غير القابلة للتغيّر تحليلًا شاملًا ما زال غير مُثبت.

## الفجوات المتبقية مرتبة

1. عالي: الكتابة الحقيقية في Codex مرفوضة على هذا المضيف رغم الوسيط الصحيح؛
   لا دليل نجاح، ولا تجاوز للسياسة.
2. عالي: نجاح استدلال/رؤية/relay OpenCode الحي غير مُثبت بسبب429.
3. متوسط: quota Codex الحية خارج ملفات CLI غير متاحة بهذه الآلية؛ التحديث
   يعيد آخر سجل مع تاريخه فقط.
4. متوسط: جلسة التطبيق الكامل، تفاعل المتصفح الحي، دورة صلاحيات تنفيذ أداة
   فعلية داخل DSH، وقتل جميع descendants غير مُثبتة.
5. أقل: اكتمال موافقة تسجيل الدخول البشري، جدولة التحديث طويلة الأمد،
   رفض ACL الحقيقي، وتحليل dead props الشامل لم يُعاد إثباتها هنا.

## الأوامر والحالة النهائية

باستخدام PowerShell:

```powershell
$env:AUDIT_DIR = Join-Path $env:TEMP 'dsh-three-step-plan-20261017'
npm test
node --check index.js
node --check client.js
node --check test/_audit.mjs
git diff --check
npm pack --dry-run --json
node test/_audit.mjs inventory
node test/_audit.mjs suites
node test/_audit.mjs mutations
node test/_audit.mjs probes
node test/_audit.mjs snapshot
node test/_audit.mjs real-capabilities
node test/_audit.mjs real-sanity
node test/_audit.mjs source-scan
node test/_audit.mjs clone
node $env:TEMP/dsh-runtime-verification-20261017/smoke.mjs
gh run list --commit 1dba984821d93ded4b09340abfe5b36fdd867128 --limit 3 --json databaseId,conclusion,headSha,url
```

السجلات تحفظ الوسيطات والأوامر الفرعية ومخرجاتها. قوائم catalog و--help
وقراءة عقود DSH نُفذت أيضًا أثناء التطوير؛ مخرجاتها موجودة في سجل أدوات
المحادثة وبعض ملفات temp. لا تدّعي هذه القائمة حصر كل أمر استكشافي.

آخر `npm test` نجح في adapter، capabilities، client، contract، dashboard،
execution، failures، ledger، model-limits، signin، update، usage، views:
**13/13 suites passed**. المتغيرات الثلاثة نجحت13/13 لكل منها.

الفرع main، commit1dba984 دون تغيير. [CI للنسخة المنشورة](https://github.com/Mans230/dsh-llm-cli/actions/runs/39076365780)
ناجح؛ CI للتعديلات المحلية غير مُثبت. لم يُنفذ commit/push/PR جديد.
أُغلقت معاينة المتصفح وخادم الاختبار المؤقت. ملف ledger الحي
`%USERPROFILE%\.dsh\llm-cli-usage.json` ما زال غائبًا؛ كل mounts استخدمت
usageFile معزولًا. مصادر استخدام CLIs بقيت منفصلة.
