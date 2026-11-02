const db = require('./db');
const { chunkText } = require('./content');

// 创建演示账号 demo / demo123，并预置一批可直接演示的数据
function seedDemo() {
  const existing = db.prepare('SELECT id FROM users WHERE username=?').get('demo');
  if (existing) return existing.id;

  const crypto = require('crypto');
  const salt = crypto.randomBytes(8).toString('hex');
  const demoId = db.prepare('INSERT INTO users(username,salt,passhash) VALUES(?,?,?)')
    .run('demo', salt, crypto.createHash('sha256').update(salt + '::demo123').digest('hex')).lastInsertRowid;

  const fCourse = db.prepare('INSERT INTO folders(user_id,name,is_public) VALUES(?,?,0)').run(demoId, '课程资料').lastInsertRowid;
  const fGold = db.prepare('INSERT INTO folders(user_id,name,is_public) VALUES(?,?,1)').run(demoId, '宝藏文章').lastInsertRowid;
  const book = db.prepare('INSERT INTO books(user_id,title,author,note) VALUES(?,?,?,?)')
    .run(demoId, '置身事内', '兰小欢', '理解中国经济与政府行为的入门读物，课程推荐。').lastInsertRowid;

  const demoItems = [
    {
      title: '土地财政：中国城市化的引擎', url: 'https://example.com/tudi-caizheng',
      folder: fCourse, book: book, author_name: '学委王同学', recommend_note: '把书里第3章讲透了，读之前先看这篇',
      tags: ['土地财政', '中国经济'], minutes: 8,
      content: '土地财政是指地方政府通过出让城市土地使用权获得收入的行为模式。1994年分税制改革后，地方政府财政收入占比下降但支出责任未减，土地出让金成为地方最重要的预算外收入来源。土地财政的核心逻辑是：政府低价征收农村土地，经过平整和基础设施建设后高价出让城市用地，差额用于城市建设。这一模式推动了中国快速的城市化，也带来了房价高企、地方债务和耕地保护等问题。近年来随着房地产市场降温，土地出让收入下滑，地方政府急需寻找新的收入来源，产业税收和消费税改革被寄予厚望。理解土地财政是理解中国城市化和地方治理的钥匙。'
    },
    {
      title: '分税制改革三十年：央地关系的再平衡', url: 'https://example.com/fenshuizhi',
      folder: fCourse, book: book, author_name: '', recommend_note: '',
      tags: ['分税制', '财政'], minutes: 12,
      content: '1994年的分税制改革将增值税等主要税种划分为中央与地方共享税，中央财政收入占比从改革前的22%跃升至55%以上。改革初衷是扭转"两个比重"过低的问题，增强中央宏观调控能力。但硬币的另一面是地方财政自给率下降，事权与财权不匹配，地方政府转而依赖土地出让金和融资平台。转移支付制度在此背景下建立，包括一般性转移支付和专项转移支付两大类。学者普遍认为，央地财政关系的再平衡需要赋予地方更多主体税种，消费税下划地方是近年讨论最多的方案之一。'
    },
    {
      title: '我为什么劝你别急着囤课', url: 'https://example.com/tun-ke',
      folder: fGold, book: null, author_name: '大四学姐', recommend_note: '收藏夹里囤了20门课的一定要看，看完你会删掉一半',
      tags: ['学习方法'], minutes: 5,
      content: '知识付费时代最大的陷阱是"收藏等于学会"。囤课带来的安全感是虚假的：你付费的瞬间大脑产生了完成感，而这个完成感恰恰消解了真正学习的动力。正确的做法是：先想清楚要解决什么问题，再去找最小够用的资料；一门课没有作业和输出，就当播客听；学完一篇，用自己的话写三句话总结，写不出来就是没学会。删掉收藏夹里三个月没打开的内容，你的学习效率会立刻提升。'
    },
    {
      title: '论文写作的第一性原理', url: 'https://example.com/lunwen',
      folder: fCourse, book: null, author_name: '导师推荐', recommend_note: '开题前必读',
      tags: ['论文写作', '科研'], minutes: 10,
      content: '论文的本质是与读者的一份论证契约：你提出一个明确的主张，用证据和推理让持有怀疑态度的读者接受它。写作的第一性原理是"为读者省力"——摘要让读者10秒决定是否继续读，引言在第一页讲清三个问题：研究什么、为什么重要、你做了什么。文献综述不是罗列，而是划出争论地图并指明你的位置。方法部分的标准是可复现。结论部分最忌讳夸大，诚实地写明局限反而增加可信度。初稿的最大敌人是完美主义，先完成再完善。'
    },
    {
      title: '番茄工作法真的适合所有人吗', url: 'https://example.com/tomato',
      folder: fGold, book: null, author_name: '舍友小李', recommend_note: '25分钟不适合深度思考，这篇给了替代方案',
      tags: ['时间管理'], minutes: 6,
      content: '番茄工作法以25分钟为单位切割时间，适合任务启动困难、容易分心的人。但深度工作的研究表明，进入心流状态平均需要15-20分钟，25分钟的番茄钟可能刚好把心流打断。替代方案是"半日区块法"：上午划出2-3小时的完整区块处理最重要的深度任务，下午再用番茄钟处理碎片事务。关键洞察是：时间管理工具的选择取决于任务类型，创造型工作需要长区块，事务型工作适合短番茄。不要让工具绑架你，先观察自己一天中什么时候头脑最清醒。'
    }
  ];

  const insertItem = db.prepare(`INSERT INTO items(user_id,title,url,content,summary,one_sentence,minutes,tags,folder_id,book_id,author_name,recommend_note,demo)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,1)`);
  const insertChunk = db.prepare('INSERT INTO chunks(item_id,idx,text) VALUES(?,?,?)');

  for (const d of demoItems) {
    const id = insertItem.run(
      demoId, d.title, d.url, d.content,
      d.content.slice(0, 110) + '……',
      d.content.slice(0, 22),
      d.minutes, JSON.stringify(d.tags), d.folder, d.book, d.author_name, d.recommend_note
    ).lastInsertRowid;
    for (const c of chunkText(d.content)) insertChunk.run(id, c.idx, c.text);
  }

  const insertComment = db.prepare('INSERT INTO comments(item_id,user_id,user_name,text) VALUES(?,?,?,?)');
  insertComment.run(1, null, '大三张同学', '原来分税制才是根源，难怪书中先讲这个');
  insertComment.run(1, null, '同班小陈', '已挂到《置身事内》第3章的资料里了，配合着读');
  insertComment.run(3, null, '隔壁班同学', '看完删掉了8门课，谢谢学姐');

  return demoId;
}

module.exports = { seedDemo };