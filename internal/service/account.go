package service

import (
	"errors"
	"regexp"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"familyledger/internal/domain"
	"familyledger/internal/repository"

	"github.com/google/uuid"
)

// AccountSortOrderItem 是批量排序提交的单项（跨端一律用 uuid 互引，§8）。
// 直接复用 repository 的载体，避免两层重复定义与字段漂移。
type AccountSortOrderItem = repository.AccountSortOrderItem

// AccountVisualUpdate 是 PATCH /api/accounts/{uuid}（批 II）的载荷。
// 三个指针字段区分「JSON 键缺失（nil = 不改）」与「显式空串（= 清除）」，
// 手法与 create 的 parent_uuid 一致。
type AccountVisualUpdate struct {
	DisplayName *string `json:"display_name"`
	Icon        *string `json:"icon"`
	Color       *string `json:"color"`
}

// AccountVisualUpdated 是账户展示字段修改的响应（最小回显）；
// 前端拿到 200 后走 markDirty('local-write') → reload 收敛，不再自拼视图。
type AccountVisualUpdated struct {
	UUID        string `json:"uuid"`
	DisplayName string `json:"display_name,omitempty"`
	Icon        string `json:"icon,omitempty"`
	Color       string `json:"color,omitempty"`
}

// accountColorRe 限定账户颜色为 #RRGGBB 六位十六进制（与前端 core 校验同口径）。
var accountColorRe = regexp.MustCompile(`^#[0-9A-Fa-f]{6}$`)

// validateAccountVisual 校验账户视觉字段（批 II 纯函数，create 与 PATCH 共用）：
//   - icon 非空时按 rune 计数不得超过 8（与前端 Array.from 码位口径一致，
//     ZWJ emoji 家族按 1 个字符计）；
//   - color 非空时必须匹配 #RRGGBB。
//
// 空串一律放行（语义是「清除」）。失败返回 400 account_visual_invalid。
func validateAccountVisual(icon, color string) error {
	if icon != "" && utf8.RuneCountInString(icon) > 8 {
		return domain.Codedf(domain.ErrInvalid, domain.CodeAccountVisualInvalid,
			"账户图标过长（最多 8 个字符），当前 %d 个", utf8.RuneCountInString(icon))
	}
	if color != "" && !accountColorRe.MatchString(color) {
		return domain.Codedf(domain.ErrInvalid, domain.CodeAccountVisualInvalid,
			"账户颜色需为 #RRGGBB 六位十六进制格式（如 #1F7A4D），当前 %q", color)
	}
	return nil
}


// AccountView 是账户列表项的返回视图（含按币种余额）。
type AccountView struct {
	ID          int64             `json:"id"`
	UUID        string            `json:"uuid"` // 批 2：列表透出 uuid（前端期初编辑/关户/删除依赖）
	Name        string            `json:"name"`
	DisplayName string            `json:"display_name,omitempty"`
	Type        string            `json:"type"`
	OpenDate    string            `json:"open_date"`
	CloseDate   string            `json:"close_date,omitempty"` // 非空表示已关闭（Beancount close）
	Restriction string            `json:"commodity_restriction,omitempty"`
	Icon        string            `json:"icon,omitempty"`
	Color       string            `json:"color,omitempty"`
	ParentUUID  string            `json:"parent_uuid,omitempty"`
	SubType     string            `json:"sub_type,omitempty"`
	SortOrder   int64             `json:"sort_order"` // 0.4-C 分类拖拽排序（同类型内升序）
	Balances    map[string]string `json:"balances,omitempty"`
}

// AccountCreated 是创建账户的返回。
type AccountCreated struct {
	ID          int64  `json:"id"`
	UUID        string `json:"uuid"`
	Name        string `json:"name"`
	DisplayName string `json:"display_name,omitempty"`
	Type        string `json:"type"`
	OpenDate    string `json:"open_date"`
	Icon        string `json:"icon,omitempty"`
	Color       string `json:"color,omitempty"`
	ParentUUID  string `json:"parent_uuid,omitempty"`
	SubType     string `json:"sub_type,omitempty"`
}

// accountRoots 是 Beancount 五大根类别（C-03）。
var accountRoots = map[string]bool{
	domain.TypeAssets:      true,
	domain.TypeLiabilities: true,
	domain.TypeEquity:      true,
	domain.TypeIncome:      true,
	domain.TypeExpenses:    true,
}

// ValidateAccountName 校验账户全名（C-03 / AC-2.3 / AC-2.4 纯函数）。
//
// 规则与 internal/seed/accounts.go 的命名约定一致，避免「落库成功、导出时才报
// Invalid account name」：
//   - 以 ':' 分段且至少两段；每段非空、段内不含空白（拦 `餐饮::早餐` 与空格）；
//   - 根段必须是 Assets/Liabilities/Equity/Expenses/Income 之一（大写开头），
//     且必须与账户 type 一致（小写根 `assets:Cash` 一律拒绝）；
//   - 根后第一段必须以 ASCII 大写字母或数字开头：`Expenses:Food:早饭` 合法、
//     `Expenses:餐饮` / `Expenses:food` 非法；
//   - 第三段起允许中文（作为展示名的落点仍建议用 display_name 列）。
//
// 错误一律携带稳定码 account_name_invalid（400）与中文可读原因。
func ValidateAccountName(name, atype string) error {
	invalid := func(format string, args ...any) error {
		return domain.Codedf(domain.ErrInvalid, domain.CodeAccountNameInvalid, format, args...)
	}
	if name == "" {
		return invalid("账户名不能为空")
	}
	if atype == "" {
		return invalid("账户类型不能为空")
	}
	parts := strings.Split(name, ":")
	if len(parts) < 2 {
		return invalid("账户名需按 Beancount 格式分段（如 Assets:Cash），至少两段")
	}
	if !accountRoots[parts[0]] {
		return invalid("账户名根段 %q 必须是 Assets / Liabilities / Equity / Expenses / Income 之一且大写开头", parts[0])
	}
	if parts[0] != atype {
		return invalid("账户名根段 %s 与账户类型 %s 不一致", parts[0], atype)
	}
	for i, part := range parts {
		if strings.TrimSpace(part) == "" {
			return invalid("名称每一段都不能为空")
		}
		for _, r := range part {
			if unicode.IsSpace(r) {
				return invalid("账户名段内不能包含空格：%q", part)
			}
		}
		if i == 1 {
			first := part[0]
			upper := first >= 'A' && first <= 'Z'
			digit := first >= '0' && first <= '9'
			if !upper && !digit {
				return invalid(
					"账户名根后第一段须以大写字母或数字开头（如 Expenses:Food）；%q 非法，中文名称请填在显示名", part)
			}
		}
	}
	return nil
}

// ListAccounts 列出账本内账户及其按币种余额。includeClosed=false 仅未关闭账户。
func (s *Service) ListAccounts(ledgerID int64, includeClosed bool) ([]AccountView, error) {
	accounts, err := s.repo.ListAccounts(ledgerID, includeClosed)
	if err != nil {
		return nil, err
	}
	balances, err := s.repo.ComputeBalances(ledgerID)
	if err != nil {
		return nil, err
	}

	out := make([]AccountView, 0, len(accounts))
	for _, a := range accounts {
		out = append(out, AccountView{
			ID:          a.ID,
			UUID:        a.UUID,
			Name:        a.Name,
			DisplayName: a.DisplayName,
			Type:        a.Type,
			OpenDate:    a.OpenDate,
			CloseDate:   a.CloseDate,
			Restriction: a.Restriction,
			Icon:        a.Icon,
			Color:       a.Color,
			ParentUUID:  a.ParentUUID,
			SubType:     a.SubType,
			SortOrder:   a.SortOrder,
			Balances:    balances[a.ID],
		})
	}
	return out, nil
}

// UpdateAccountSortOrders 校验并批量落库账户排序（P0 分类拖拽排序）。
//
// 校验约定与 ValidateAccountName 一致：ErrInvalid + 中文原因（→HTTP 400）：
// 空列表 / 空 uuid / 负 sort_order / 同一批内 uuid 重复。
// 「非本账本 uuid」由 repository 的 UPDATE 守卫判定，同样返回 ErrInvalid。
// 校验不通过时不落库、不写 sync_log。
func (s *Service) UpdateAccountSortOrders(ledgerID int64, orders []AccountSortOrderItem) (int64, error) {
	if len(orders) == 0 {
		return 0, domain.Invalidf("排序项不能为空")
	}
	seen := make(map[string]bool, len(orders))
	for _, item := range orders {
		if item.UUID == "" {
			return 0, domain.Invalidf("排序项的账户 uuid 不能为空")
		}
		if item.SortOrder < 0 {
			return 0, domain.Invalidf("排序序号不能为负数：账户 %s 的 sort_order=%d", item.UUID, item.SortOrder)
		}
		if seen[item.UUID] {
			return 0, domain.Invalidf("同一批次内账户 uuid 重复：%s", item.UUID)
		}
		seen[item.UUID] = true
	}
	return s.repo.UpdateAccountSortOrders(ledgerID, orders)
}

// CreateAccount 创建账户（含币种限制时自动补建币种）。
// icon/color/parentUUID/subType 为展示/层级字段，可选。
//
// 0.6.0 S2（D-04 / C-03 / C-04）：新增账户名格式校验、含已关闭账户的重名判定、
// 以及父账户校验。传了非空 parentUUID 而校验失败一律拒绝，绝不静默忽略降级为根。
// FR-03：未显式传日期时 open_date = min(账本期初日期, 今日)；显式日期不得晚于账本期初日期。
func (s *Service) CreateAccount(ledgerID int64, name, displayName, atype, openDate, commodity, icon, color, parentUUID, subType string) (AccountCreated, error) {
	if name == "" || atype == "" {
		return AccountCreated{}, domain.Invalidf("name 与 type 必填")
	}
	if err := validateAccountType(atype); err != nil {
		return AccountCreated{}, err
	}
	if err := ValidateAccountName(name, atype); err != nil {
		return AccountCreated{}, err
	}
	// 批 II：create 路径同步接入视觉字段校验（此前 icon/color 不设防）。
	// 冒烟脚本不传 icon/color 不受影响；seed 默认账户走 repository 直插，同样不受影响。
	if err := validateAccountVisual(icon, color); err != nil {
		return AccountCreated{}, err
	}
	// 重名含已关闭账户：repository.AccountNameExists 只排除软删行，
	// close 后的同名账户仍占用全局唯一名（C-04，close 后不可重建同名）。
	if existing, err := s.repo.AccountNameExists(ledgerID, name); err != nil {
		return AccountCreated{}, err
	} else if existing != "" {
		return AccountCreated{}, domain.Codedf(domain.ErrConflict, domain.CodeAccountNameExists,
			"账户名 %s 已被占用（含已关闭账户），请换一个名称", name)
	}
	// 父校验：存在（含跨账本 / 软删判定）、同 type、未关闭。
	if parentUUID != "" {
		parent, err := s.repo.AccountByUUID(ledgerID, parentUUID)
		if err != nil {
			if errors.Is(err, domain.ErrNotFound) {
				return AccountCreated{}, domain.Codedf(domain.ErrInvalid, domain.CodeParentNotFound,
					"父账户不存在、属于其他账本或已删除")
			}
			return AccountCreated{}, err
		}
		if parent.CloseDate != "" {
			return AccountCreated{}, domain.Invalidf("父账户已关闭，无法增加下级")
		}
		if parent.Type != atype {
			return AccountCreated{}, domain.Codedf(domain.ErrConflict, domain.CodeParentTypeMismatch,
				"父账户类型不匹配（父为 %s，子为 %s）", parent.Type, atype)
		}
	}

	openingDate, err := s.repo.LedgerOpeningDate(ledgerID)
	if err != nil {
		return AccountCreated{}, err
	}
	today := time.Now().Format("2006-01-02")
	if openingDate == "" || openingDate > today {
		openingDate = today
	}
	if openDate == "" {
		openDate = openingDate
	} else {
		if !isISODate(openDate) {
			return AccountCreated{}, domain.Invalidf("open_date 需为 YYYY-MM-DD")
		}
		if openDate > openingDate {
			return AccountCreated{}, domain.Codedf(domain.ErrInvalid, domain.CodeAccountOpenDateAfter,
				"账户开立日期不得晚于账本期初日期 %s", openingDate)
		}
	}

	a := domain.Account{
		UUID:        uuid.NewString(),
		Name:        name,
		DisplayName: displayName,
		Type:        atype,
		OpenDate:    openDate,
		Restriction: commodity,
		Icon:        icon,
		Color:       color,
		ParentUUID:  parentUUID,
		SubType:     subType,
	}
	id, err := s.repo.InsertAccount(ledgerID, a)
	if err != nil {
		return AccountCreated{}, err
	}
	return AccountCreated{
		ID: id, UUID: a.UUID, Name: name, DisplayName: displayName, Type: atype,
		OpenDate: openDate, Icon: icon, Color: color, ParentUUID: parentUUID, SubType: subType,
	}, nil
}

// UpdateAccountVisual 修改账户展示字段（批 II：PATCH /api/accounts/{uuid}）。
//
// 语义：
//   - 三个键全缺失 → 400（绝不把「空请求」当成「无操作成功」）；
//   - 键存在即应用：display_name trim 后空串 = 清除；icon/color 空串 = 清除；
//   - 键缺失 = 保持现值（先读回当前账户再回填，repository 是三列全量 UPDATE）；
//   - 无重名判定（display_name 无唯一约束，seed 多个「其他」共用；重名判定是
//     name 字段的规则且本端点不改 name）；
//   - 已关户账户可改（纯展示字段）；软删 / 跨账本 / 不存在 → 404 account_not_found。
//
// UPDATE 与 sync_log(op=update) 同事务（repository 保证），其他端 pull 后展示一致。
// 导出器不含三字段，.beancount 字节不变。
func (s *Service) UpdateAccountVisual(ledgerID int64, uuid string, req AccountVisualUpdate) (AccountVisualUpdated, error) {
	if req.DisplayName == nil && req.Icon == nil && req.Color == nil {
		return AccountVisualUpdated{}, domain.Invalidf(
			"请求体为空：display_name / icon / color 至少提供一个字段（空串表示清除）")
	}
	// 先读当前账户：键缺失字段要回填现值；顺带把 404 在这里判掉（行不存在 /
	// 跨账本 / 已软删时 AccountByUUID 返回 ErrNotFound）。
	current, err := s.repo.AccountByUUID(ledgerID, uuid)
	if err != nil {
		if errors.Is(err, domain.ErrNotFound) {
			return AccountVisualUpdated{}, domain.Codedf(domain.ErrNotFound, domain.CodeAccountNotFound,
				"账户不存在或已删除（uuid=%s）", uuid)
		}
		return AccountVisualUpdated{}, err
	}
	displayName := current.DisplayName
	if req.DisplayName != nil {
		displayName = strings.TrimSpace(*req.DisplayName)
	}
	icon := current.Icon
	if req.Icon != nil {
		// trim 防误粘首尾空白挤占 8 字符码位配额（emoji 本身不含空白）。
		icon = strings.TrimSpace(*req.Icon)
	}
	color := current.Color
	if req.Color != nil {
		color = strings.TrimSpace(*req.Color)
	}
	if err := validateAccountVisual(icon, color); err != nil {
		return AccountVisualUpdated{}, err
	}
	updated, err := s.repo.UpdateAccountVisual(ledgerID, uuid, displayName, icon, color)
	if err != nil {
		return AccountVisualUpdated{}, err
	}
	if !updated {
		// 理论上先读后写在 MaxOpenConns=1 下不会竞态；兜底同样映射 404。
		return AccountVisualUpdated{}, domain.Codedf(domain.ErrNotFound, domain.CodeAccountNotFound,
			"账户不存在或已删除（uuid=%s）", uuid)
	}
	return AccountVisualUpdated{UUID: uuid, DisplayName: displayName, Icon: icon, Color: color}, nil
}

// DeleteAccount 关闭账户（Beancount close 语义，0.4-A 起）。
// 关闭前必须余额为 0（设计决策 §7.3）：非 0 返回 BalanceNotZeroError（409 + 按币种差额）。
// 校验通过则置 close_date，保留全部交易引用；sync_log 写 op=close。
func (s *Service) DeleteAccount(ledgerID int64, uuid string) error {
	closed, diffs, err := s.repo.CloseAccountChecked(ledgerID, uuid)
	if err != nil {
		return err
	}
	if len(diffs) > 0 {
		return &domain.BalanceNotZeroError{AccountUUID: uuid, Balances: diffs}
	}
	if !closed {
		return domain.ErrNotFound
	}
	return nil
}
