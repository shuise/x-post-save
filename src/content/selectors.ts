/**
 * 所有 DOM 选择器集中在这里，X 改版时只需要改这一个文件。
 * 注意：绝不要用 aria-label，它会被本地化（中文界面下是「取消喜欢」）。
 */
import { LIKES_PAGE_PATH } from '../shared/paths';

export const SEL = {
  /** 一条推文的根节点 */
  tweet: 'article[data-testid="tweet"]',
  /** 已点亮（已点赞）的爱心按钮 */
  unlike: 'button[data-testid="unlike"]',
  /** 未点亮的爱心按钮，用于确认点击生效 */
  like: 'button[data-testid="like"]',
  /** 推文内部的时间元素，用它来区分外层推文与引用推文的卡片链接 */
  time: 'time',
  /** 虚拟滚动的单元格 */
  cell: '[data-testid="cellInnerDiv"]',
  /** 主时间线容器，用于把错误横幅的搜索范围限制在时间线内 */
  primaryColumn: '[data-testid="primaryColumn"]',
} as const;

export const LIKES_PATH = LIKES_PAGE_PATH;

/** 错误横幅文案。用精确匹配避免误伤正文里出现「重试」的推文。 */
export const ERROR_BANNER_TEXTS = [
  'Something went wrong',
  'Try again',
  'Retry',
  '重试',
  '出错了',
  '出错了，请重试',
  '出现问题',
];