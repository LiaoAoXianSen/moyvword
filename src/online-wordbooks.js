const https = require('https');

const WORD_BOOK_CATALOG = [
  {
    id: 'cet4',
    name: '大学英语四级',
    source: 'mahavivo/english-wordlists',
    url: 'https://raw.githubusercontent.com/mahavivo/english-wordlists/master/CET4_edited.txt'
  },
  {
    id: 'cet6',
    name: '大学英语六级',
    source: 'mahavivo/english-wordlists',
    url: 'https://raw.githubusercontent.com/mahavivo/english-wordlists/master/CET6_edited.txt'
  },
  {
    id: 'npee',
    name: '考研英语',
    source: 'mahavivo/english-wordlists',
    url: 'https://raw.githubusercontent.com/mahavivo/english-wordlists/master/NPEE_Wordlist.txt'
  },
  {
    id: 'toefl',
    name: 'TOEFL 托福',
    source: 'mahavivo/english-wordlists',
    url: 'https://raw.githubusercontent.com/mahavivo/english-wordlists/master/TOEFL.txt'
  },
  {
    id: 'gre',
    name: 'GRE 核心',
    source: 'mahavivo/english-wordlists',
    url: 'https://raw.githubusercontent.com/mahavivo/english-wordlists/master/GRE_abridged.txt'
  },
  {
    id: 'zhongkao',
    name: '中考英语',
    source: 'mahavivo/english-wordlists',
    url: 'https://raw.githubusercontent.com/mahavivo/english-wordlists/master/%E4%B8%AD%E8%80%83%E8%8B%B1%E8%AF%AD%E8%AF%8D%E6%B1%87%E8%A1%A8.txt'
  },
  {
    id: 'highschool',
    name: '高中英语',
    source: 'mahavivo/english-wordlists',
    url: 'https://raw.githubusercontent.com/mahavivo/english-wordlists/master/Highschool_edited.txt'
  }
];

const BUILTIN_WORD_BOOKS = {
  cet4: `
ability [ə'bɪləti] n. 能力；才能
absorb [əb'sɔːb] v. 吸收；理解
academic [ˌækə'demɪk] adj. 学术的
access ['ækses] n. 通道；使用权
accurate ['ækjərət] adj. 准确的
achieve [ə'tʃiːv] v. 达到；完成
adapt [ə'dæpt] v. 适应；改编
adjust [ə'dʒʌst] v. 调整；适应
advantage [əd'vɑːntɪdʒ] n. 优势
affect [ə'fekt] v. 影响
analysis [ə'næləsɪs] n. 分析
approach [ə'prəʊtʃ] n. 方法；接近
assume [ə'sjuːm] v. 假定；承担
available [ə'veɪləbl] adj. 可获得的
benefit ['benɪfɪt] n. 益处；v. 受益
challenge ['tʃælɪndʒ] n. 挑战
community [kə'mjuːnəti] n. 社区；群体
concentrate ['kɒnsntreɪt] v. 集中
confidence ['kɒnfɪdəns] n. 信心
consider [kən'sɪdə] v. 考虑
`,
  cet6: `
abundant [ə'bʌndənt] adj. 丰富的
accelerate [ək'seləreɪt] v. 加速
acknowledge [ək'nɒlɪdʒ] v. 承认；致谢
adequate ['ædɪkwət] adj. 足够的
advocate ['ædvəkeɪt] v. 提倡；n. 支持者
allocate ['æləkeɪt] v. 分配
ambiguous [æm'bɪɡjuəs] adj. 含糊的
anticipate [æn'tɪsɪpeɪt] v. 预期
apparently [ə'pærəntli] adv. 显然
approximately [ə'prɒksɪmətli] adv. 大约
arbitrary ['ɑːbɪtrəri] adj. 任意的
assess [ə'ses] v. 评估
capacity [kə'pæsəti] n. 容量；能力
coherent [kəʊ'hɪərənt] adj. 连贯的
comprehensive [ˌkɒmprɪ'hensɪv] adj. 全面的
`,
  npee: `
abstract ['æbstrækt] adj. 抽象的；n. 摘要
accompany [ə'kʌmpəni] v. 陪伴；伴随
accumulate [ə'kjuːmjəleɪt] v. 积累
administration [ədˌmɪnɪ'streɪʃn] n. 管理；行政
alternative [ɔːl'tɜːnətɪv] n. 替代方案
appropriate [ə'prəʊpriət] adj. 合适的
authority [ɔː'θɒrəti] n. 权威；当局
circumstance ['sɜːkəmstəns] n. 情况
consequence ['kɒnsɪkwəns] n. 后果
constitute ['kɒnstɪtjuːt] v. 构成
`,
  toefl: `
abandon [ə'bændən] v. 放弃
adaptation [ˌædæp'teɪʃn] n. 适应；改编
adjacent [ə'dʒeɪsnt] adj. 相邻的
aggregate ['æɡrɪɡət] n. 总数；adj. 总计的
agriculture ['æɡrɪkʌltʃə] n. 农业
artifact ['ɑːtɪfækt] n. 人工制品
climate ['klaɪmət] n. 气候
component [kəm'pəʊnənt] n. 组成部分
deposit [dɪ'pɒzɪt] n. 沉积物；v. 存放
diverse [daɪ'vɜːs] adj. 多样的
`,
  gre: `
aberrant [æ'berənt] adj. 异常的
abstemious [æb'stiːmiəs] adj. 有节制的
acrimony ['ækrɪməni] n. 尖刻；刻薄
admonish [əd'mɒnɪʃ] v. 告诫
anomaly [ə'nɒməli] n. 异常
apathy ['æpəθi] n. 冷漠
assiduous [ə'sɪdjuəs] adj. 勤勉的
capricious [kə'prɪʃəs] adj. 反复无常的
conundrum [kə'nʌndrəm] n. 难题
erudite ['erjʊdaɪt] adj. 博学的
`,
  zhongkao: `
accident ['æksɪdənt] n. 事故
address [ə'dres] n. 地址；v. 写地址
afraid [ə'freɪd] adj. 害怕的
already [ɔːl'redi] adv. 已经
although [ɔːl'ðəʊ] conj. 虽然
beautiful ['bjuːtɪfl] adj. 美丽的
because [bɪ'kɒz] conj. 因为
borrow ['bɒrəʊ] v. 借入
careful ['keəfl] adj. 小心的
choose [tʃuːz] v. 选择
`,
  highschool: `
abroad [ə'brɔːd] adv. 在国外
absence ['æbsəns] n. 缺席
absolute ['æbsəluːt] adj. 绝对的
accent ['æksent] n. 口音
acceptable [ək'septəbl] adj. 可接受的
account [ə'kaʊnt] n. 账户；解释
actually ['æktʃuəli] adv. 实际上
addition [ə'dɪʃn] n. 增加
adventure [əd'ventʃə] n. 冒险
anxious ['æŋkʃəs] adj. 焦虑的
`
};

function reportProgress(onProgress, progress) {
  if (typeof onProgress === 'function') onProgress(progress);
}

function downloadTextOnce(url, redirects = 0, onProgress) {
  return new Promise((resolve, reject) => {
    reportProgress(onProgress, { stage: 'connect', label: '连接词书源...', percent: 5 });
    const request = https.get(url, {
      headers: { 'User-Agent': 'moyu-vocab-strip' },
      timeout: 60000
    }, (response) => {
      if ([301, 302, 307, 308].includes(response.statusCode) && response.headers.location && redirects < 4) {
        response.resume();
        reportProgress(onProgress, { stage: 'redirect', label: '跟随下载地址...', percent: 8 });
        downloadTextOnce(response.headers.location, redirects + 1, onProgress).then(resolve, reject);
        return;
      }
      if (response.statusCode < 200 || response.statusCode >= 300) {
        response.resume();
        reject(new Error(`下载失败：HTTP ${response.statusCode}`));
        return;
      }
      response.setEncoding('utf8');
      let body = '';
      let received = 0;
      const total = Number(response.headers['content-length']) || 0;
      response.on('data', (chunk) => {
        body += chunk;
        received += Buffer.byteLength(chunk, 'utf8');
        const downloadPercent = total ? Math.min(70, 10 + (received / total) * 60) : 0;
        reportProgress(onProgress, {
          stage: 'download',
          label: total ? `下载词表 ${Math.min(99, Math.round((received / total) * 100))}%` : '下载词表...',
          received,
          total,
          percent: total ? downloadPercent : null
        });
      });
      response.on('end', () => resolve(body));
    });
    request.on('timeout', () => {
      request.destroy(new Error('下载超时'));
    });
    request.on('error', reject);
  });
}

async function downloadText(url, onProgress) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      reportProgress(onProgress, { stage: 'attempt', label: `尝试下载 ${attempt}/3...`, percent: Math.min(12, 4 + attempt * 2) });
      return await downloadTextOnce(url, 0, onProgress);
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, attempt * 600));
    }
  }
  throw lastError;
}

function mirrorUrls(url) {
  const match = url.match(/^https:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/([^/]+)\/(.+)$/);
  if (!match) return [url];
  const [, owner, repo, branch, filePath] = match;
  const encodedPath = filePath.split('/').map(encodeURIComponent).join('/');
  return [
    url,
    `https://cdn.jsdelivr.net/gh/${owner}/${repo}@${branch}/${encodedPath}`,
    `https://fastly.jsdelivr.net/gh/${owner}/${repo}@${branch}/${encodedPath}`
  ];
}

function parseWordbookText(text) {
  return String(text || '')
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .map(parseLine)
    .filter(Boolean);
}

function parseLine(rawLine) {
  const line = String(rawLine || '').trim();
  if (!line || /^[A-Z]$/.test(line) || /^（?共\s*\d+\s*词/.test(line) || /词表|单词表|wordlist/i.test(line)) return null;
  const wordMatch = line.match(/^([A-Za-z][A-Za-z'’-]*)\b/);
  if (!wordMatch) return null;
  const word = wordMatch[1].replace(/[’]/g, "'").replace(/[.。,:;，；：]+$/, '').trim();
  if (!word || word.length > 40) return null;
  const rest = line.slice(wordMatch[0].length).trim();
  const phoneticMatch = rest.match(/^\[([^\]]+)\]\s*/);
  const phonetic = phoneticMatch ? `[${phoneticMatch[1]}]` : '';
  const meaning = (phoneticMatch ? rest.slice(phoneticMatch[0].length) : rest)
    .replace(/\s+/g, ' ')
    .trim();
  return { word, phonetic, meaning, sentence: '' };
}

async function downloadWordBook(bookId, onProgress) {
  const book = WORD_BOOK_CATALOG.find((item) => item.id === bookId);
  if (!book) throw new Error('没有找到这个在线词书');
  let text = '';
  let lastError;
  for (const url of mirrorUrls(book.url)) {
    try {
      reportProgress(onProgress, { stage: 'source', label: '选择下载源...', percent: 3 });
      text = await downloadText(url, onProgress);
      break;
    } catch (error) {
      lastError = error;
    }
  }
  let source = 'online';
  if (!text && BUILTIN_WORD_BOOKS[bookId]) {
    text = BUILTIN_WORD_BOOKS[bookId];
    source = 'builtin';
    reportProgress(onProgress, { stage: 'builtin', label: '网络不可用，使用内置词表...', percent: 65 });
  }
  if (!text) throw lastError || new Error('下载失败');
  reportProgress(onProgress, { stage: 'parse', label: '解析词条...', percent: 78 });
  const records = parseWordbookText(text);
  if (!records.length) throw new Error('词书解析失败');
  reportProgress(onProgress, { stage: 'parsed', label: `解析到 ${records.length} 个词条`, percent: 85 });
  return { book, records, source };
}

module.exports = {
  WORD_BOOK_CATALOG,
  downloadWordBook,
  parseWordbookText
};
