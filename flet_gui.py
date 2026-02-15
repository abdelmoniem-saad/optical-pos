import flet as ft
from splitmates.model.models import User, Category, Split
from splitmates.repository.group_repository import GroupRepository
from uuid import UUID
import datetime
import csv
import os
import sys

class SplitMatesFletGUI:
    def __init__(self, page: ft.Page):
        print("SplitMatesFletGUI.__init__ started")
        sys.stdout.flush()
        self.page = page
        self.page.title = "SplitMates"
        self.page.theme_mode = ft.ThemeMode.SYSTEM
        self.page.padding = 0
        self.page.window_width = 400
        self.page.window_height = 800
        self.page.theme = ft.Theme(color_scheme_seed=ft.colors.GREEN)

        try:
            print("Initializing Data Repository...")
            sys.stdout.flush()
            # Initialize Data
            self.repository = GroupRepository()
            print("Fetching groups...")
            sys.stdout.flush()
            groups = self.repository.get_all_groups()
            print(f"Groups found: {len(groups)}")
            sys.stdout.flush()
            if groups:
                self.group = groups[0]
            else:
                print("No groups found, creating default...")
                sys.stdout.flush()
                self.group = self.repository.create_group("My Shared Expenses")
            
            print(f"Setting up manager for group: {self.group.name}")
            sys.stdout.flush()
            self.manager = self.repository.get_group_manager(self.group.id)
            
            # State
            self.active_index = 0
            
            # Components
            print("Setting up UI components...")
            sys.stdout.flush()
            self.setup_ui()
            print("SplitMatesFletGUI initialization complete")
            sys.stdout.flush()
        except Exception as e:
            print(f"Error during initialization: {e}")
            sys.stdout.flush()
            self.show_fatal_error(e)

    def show_fatal_error(self, e):
        import traceback
        error_details = traceback.format_exc()
        print(f"Fatal Error: {error_details}") # Also print to console
        self.page.add(
            ft.Container(
                content=ft.Column(
                    [
                        ft.Icon(ft.icons.ERROR_OUTLINE, color=ft.colors.RED, size=50),
                        ft.Text("SplitMates failed to start", size=20, weight=ft.FontWeight.BOLD),
                        ft.Text(f"Error: {str(e)}", color=ft.colors.RED),
                        ft.ExpansionTile(
                            title=ft.Text("View Error Details"),
                            controls=[
                                ft.Container(
                                    content=ft.Text(error_details, font_family="monospace", size=10),
                                    padding=10,
                                    bgcolor=ft.colors.SURFACE_CONTAINER,
                                    border_radius=5
                                )
                            ]
                        ),
                        ft.ElevatedButton("Retry", on_click=lambda _: self.page.client_storage.clear() or self.page.window_reload())
                    ],
                    horizontal_alignment=ft.CrossAxisAlignment.CENTER,
                    spacing=20,
                ),
                alignment=ft.Alignment.CENTER,
                padding=20,
            )
        )
        self.page.update()

    def setup_ui(self):
        # Navigation Bar
        self.nav_bar = ft.NavigationBar(
            destinations=[
                ft.NavigationBarDestination(icon=ft.icons.DASHBOARD_ROUNDED, label="Summary"),
                ft.NavigationBarDestination(icon=ft.icons.RECEIPT_LONG_ROUNDED, label="Expenses"),
                ft.NavigationBarDestination(icon=ft.icons.PEOPLE_ROUNDED, label="Members"),
                ft.NavigationBarDestination(icon=ft.icons.ANALYTICS_ROUNDED, label="Analytics"),
            ],
            on_change=self.on_nav_change,
            selected_index=0,
        )

        # AppBar
        self.app_bar = ft.AppBar(
            title=ft.Text("SplitMates", weight=ft.FontWeight.BOLD),
            center_title=False,
            bgcolor=ft.colors.SURFACE_CONTAINER,
            leading=ft.IconButton(ft.icons.MENU, on_click=lambda _: self.open_drawer()),
            actions=[
                ft.IconButton(ft.icons.EDIT, tooltip="Rename Group", on_click=self.show_rename_group_dialog),
                ft.IconButton(ft.icons.GROUP_ADD, on_click=self.show_new_group_dialog),
                ft.PopupMenuButton(
                    items=[
                        ft.PopupMenuItem(content=ft.Text("Change Theme"), icon=ft.icons.PALETTE, on_click=self.toggle_theme),
                    ]
                ),
            ],
        )

        # Main view container
        self.main_container = ft.Container(expand=True, padding=10)
        
        # Drawer for group selection
        self.drawer = ft.NavigationDrawer(
            on_change=self.on_group_select,
            controls=[
                ft.Container(height=12),
                ft.Container(content=ft.Text("Select Group", size=20, weight=ft.FontWeight.BOLD), padding=ft.Padding.only(left=16, top=10, bottom=10)),
                ft.Divider(),
            ]
        )
        self.update_drawer_groups()

        self.page.appbar = self.app_bar
        self.page.navigation_bar = self.nav_bar
        self.page.drawer = self.drawer
        
        self.page.add(self.main_container)
        self.refresh_view()

    def open_drawer(self):
        self.drawer.open = True
        self.page.update()

    def update_drawer_groups(self):
        groups = self.repository.get_all_groups()
        # Keep the header controls
        header_controls = [
            ft.Container(height=12),
            ft.Container(content=ft.Text("Select Group", size=20, weight=ft.FontWeight.BOLD), padding=ft.Padding.only(left=16, top=10, bottom=10)),
            ft.Divider(),
        ]
        group_controls = []
        for g in groups:
            group_controls.append(
                ft.NavigationDrawerDestination(
                    label=g.name,
                    icon=ft.icons.GROUP_OUTLINED,
                    selected_icon=ft.icons.GROUP,
                )
            )
        
        # Add a footer for deleting current group
        footer = [
            ft.Divider(),
            ft.NavigationDrawerDestination(
                label="Delete Current Group",
                icon=ft.icons.DELETE_OUTLINE,
            )
        ]
        
        self.drawer.controls = header_controls + group_controls + footer
        
        # Find index of current group
        try:
            current_index = [g.id for g in groups].index(self.group.id)
            self.drawer.selected_index = current_index
        except ValueError:
            pass
        
        if self.page:
            self.page.update()

    def show_snackbar(self, message):
        self.page.snack_bar = ft.SnackBar(ft.Text(message), behavior=ft.SnackBarBehavior.FLOATING)
        self.page.snack_bar.open = True
        self.page.update()

    def on_group_select(self, e):
        idx = e.control.selected_index
        groups = self.repository.get_all_groups()
        
        if idx is not None and idx < len(groups):
            new_group = groups[idx]
            self.group = new_group
            self.manager = self.repository.get_group_manager(self.group.id)
            self.drawer.open = False
            self.refresh_view()
        elif idx == len(groups): # Delete button
            self.show_delete_confirmation()
            self.drawer.open = False
        
        self.page.update()

    def on_nav_change(self, e):
        self.active_index = e.control.selected_index
        self.refresh_view()

    def toggle_theme(self, _):
        self.page.theme_mode = ft.ThemeMode.DARK if self.page.theme_mode == ft.ThemeMode.LIGHT else ft.ThemeMode.LIGHT
        self.page.update()

    def refresh_view(self):
        self.main_container.content = None
        self.page.floating_action_button = None
        
        if self.active_index == 0:
            self.main_container.content = self.get_summary_view()
        elif self.active_index == 1:
            self.main_container.content = self.get_expenses_view()
            self.page.floating_action_button = ft.FloatingActionButton(
                icon=ft.icons.ADD, on_click=self.show_add_expense_dialog, bgcolor=ft.colors.GREEN
            )
        elif self.active_index == 2:
            self.main_container.content = self.get_members_view()
        elif self.active_index == 3:
            self.main_container.content = self.get_analytics_view()
            
        self.app_bar.title.value = f"{self.group.name}"
        self.page.update()

    # --- VIEWS ---

    def get_summary_view(self):
        balances = self.manager.get_balances()
        expenses = self.manager.get_expenses()
        total_spent = sum(e.amount for e in expenses)
        
        # Group stats
        stats_row = ft.Row(
            [
                self.get_stat_card("Members", f"{len(self.group.members)}", "Active"),
                self.get_stat_card("Expenses", f"{len(expenses)}", "Recorded"),
            ],
            alignment=ft.MainAxisAlignment.SPACE_AROUND
        )

        balance_controls = []
        if not balances:
            balance_controls.append(ft.Container(content=ft.Text("No active balances", italic=True), padding=10, alignment=ft.Alignment.CENTER))
        else:
            for user, balance in sorted(balances.items(), key=lambda x: x[1], reverse=True):
                initials = "".join([n[0] for n in user.name.split()])[:2].upper()
                color = ft.colors.GREEN if balance >= 0 else ft.colors.RED
                status = "is owed" if balance >= 0 else "owes"
                
                balance_controls.append(
                    ft.Card(
                        content=ft.ListTile(
                            leading=ft.CircleAvatar(content=ft.Text(initials), bgcolor=ft.colors.GREEN if balance >= 0 else ft.colors.BLUE_GREY),
                            title=ft.Text(user.name, weight=ft.FontWeight.BOLD),
                            subtitle=ft.Text(f"{status} ${abs(balance):.2f}", color=color),
                        )
                    )
                )

        settlements = self.manager.get_simplified_debts()
        settlement_controls = []
        if not settlements:
            settlement_controls.append(ft.Container(content=ft.Text("All settled up! ✨", italic=True), padding=10, alignment=ft.Alignment.CENTER))
        else:
            self.settlement_radios = ft.RadioGroup(
                content=ft.Column(
                    controls=[
                        ft.Card(
                            content=ft.ListTile(
                                leading=ft.Radio(value=str(i)),
                                title=ft.Text(f"{s.from_user.name} → {s.to_user.name}"),
                                trailing=ft.Text(f"${abs(s.amount):.2f}", weight=ft.FontWeight.BOLD),
                            )
                        ) for i, s in enumerate(settlements)
                    ]
                )
            )
            settlement_controls.append(self.settlement_radios)
            settlement_controls.append(
                ft.Row(
                    [
                        ft.ElevatedButton("Mark as Paid", icon=ft.icons.CHECK, on_click=self.settle_selected),
                        ft.TextButton("Custom Payment", on_click=self.show_manual_settlement_dialog)
                    ],
                    alignment=ft.MainAxisAlignment.CENTER
                )
            )

        return ft.Column(
            scroll=ft.ScrollMode.AUTO,
            controls=[
                ft.Container(
                    content=ft.Column(
                        [
                            ft.Text("Total Group Spending", size=14, color=ft.colors.ON_SURFACE_VARIANT),
                            ft.Text(f"${total_spent:,.2f}", size=32, weight=ft.FontWeight.BOLD),
                        ],
                        horizontal_alignment=ft.CrossAxisAlignment.CENTER,
                    ),
                    alignment=ft.Alignment.CENTER,
                    padding=20,
                    bgcolor=ft.colors.SURFACE_CONTAINER,
                    border_radius=10,
                ),
                stats_row,
                ft.Text("Balances", size=20, weight=ft.FontWeight.BOLD),
                *balance_controls,
                ft.Text("Suggested Settlements", size=20, weight=ft.FontWeight.BOLD),
                *settlement_controls,
            ]
        )

    def get_expenses_view(self):
        expenses = sorted(self.manager.get_expenses(), key=lambda x: x.date, reverse=True)
        
        self.search_field = ft.TextField(
            hint_text="Search expenses...",
            prefix_icon=ft.icons.SEARCH,
            on_change=self.on_expense_search,
            border_radius=10,
            expand=True,
        )

        self.expense_list = ft.Column(scroll=ft.ScrollMode.AUTO, expand=True)
        self.render_expense_list(expenses)

        return ft.Column(
            expand=True,
            controls=[
                ft.Row(
                    [
                        self.search_field,
                        ft.IconButton(ft.icons.CLEAR, tooltip="Clear Search", on_click=self.clear_search),
                        ft.IconButton(ft.icons.FILE_DOWNLOAD, tooltip="Export CSV", on_click=self.export_expenses_csv)
                    ], 
                    alignment=ft.MainAxisAlignment.SPACE_BETWEEN
                ),
                self.expense_list
            ]
        )

    def clear_search(self, _):
        self.search_field.value = ""
        self.render_expense_list(sorted(self.manager.get_expenses(), key=lambda x: x.date, reverse=True))

    def render_expense_list(self, expenses):
        self.expense_list.controls = []
        if not expenses:
            self.expense_list.controls.append(ft.Text("No expenses found.", italic=True, text_align=ft.TextAlign.CENTER))
        else:
            for e in expenses:
                date_str = datetime.datetime.fromtimestamp(e.date).strftime("%b %d")
                cat_icons = {
                    Category.GROCERIES: ft.icons.SHOPPING_CART,
                    Category.UTILITIES: ft.icons.LIGHTBULB,
                    Category.HOUSEHOLD: ft.icons.HOME,
                    Category.FOOD_DELIVERY: ft.icons.PEDAL_BIKE,
                    Category.OTHER: ft.icons.INBOX,
                }
                icon = cat_icons.get(e.category, ft.icons.INBOX)
                
                self.expense_list.controls.append(
                    ft.Card(
                        content=ft.ListTile(
                            leading=ft.Column([ft.Text(date_str, size=10), ft.Icon(icon)], alignment=ft.MainAxisAlignment.CENTER, spacing=2),
                            title=ft.Text(e.description, weight=ft.FontWeight.BOLD),
                            subtitle=ft.Text(f"Paid by {e.paid_by.name}"),
                            trailing=ft.Row(
                                [
                                    ft.Text(f"${e.amount:.2f}", weight=ft.FontWeight.BOLD),
                                    ft.IconButton(ft.icons.DELETE_OUTLINE, icon_color=ft.colors.RED, on_click=lambda _, eid=e.id: self.delete_expense_event(eid))
                                ],
                                tight=True
                            ),
                        )
                    )
                )
        self.page.update()

    def get_members_view(self):
        self.member_name_field = ft.TextField(hint_text="Member Name", expand=True)
        
        # Calculate total spent by each member
        member_spending = {}
        for m in self.group.members:
            member_spending[m.id] = sum(e.amount for e in self.manager.get_expenses() if e.paid_by.id == m.id)

        member_cards = []
        for m in self.group.members:
            initials = "".join([n[0] for n in m.name.split()])[:2].upper()
            spent = member_spending.get(m.id, 0.0)
            
            # Can delete member only if not involved in any transaction
            can_delete = not self.manager.is_user_involved(m.id)
            
            member_cards.append(
                ft.Card(
                    content=ft.ListTile(
                        leading=ft.CircleAvatar(content=ft.Text(initials)),
                        title=ft.Text(m.name, weight=ft.FontWeight.BOLD),
                        subtitle=ft.Text(f"Total Paid: ${spent:.2f}"),
                        trailing=ft.IconButton(
                            ft.icons.DELETE_OUTLINE, 
                            icon_color=ft.colors.RED if can_delete else ft.colors.GREY_400,
                            tooltip="Remove Member" if can_delete else "Cannot remove (has transactions)",
                            on_click=lambda _, mid=m.id: self.delete_member(mid) if can_delete else None,
                            disabled=not can_delete
                        )
                    )
                )
            )

        return ft.Column(
            controls=[
                ft.Row([self.member_name_field, ft.ElevatedButton("Add", icon=ft.icons.ADD, on_click=self.add_member)]),
                ft.Divider(),
                ft.Column(scroll=ft.ScrollMode.AUTO, controls=member_cards, expand=True)
            ]
        )

    def get_analytics_view(self):
        spending = self.manager.get_category_spending()
        total = sum(spending.values())
        
        if total == 0:
            return ft.Column([ft.Text("Add some expenses to see analytics!", italic=True)], alignment=ft.MainAxisAlignment.CENTER)

        # Stats Cards
        spender_balances = {}
        for e in self.manager.get_expenses():
            spender_balances[e.paid_by.name] = spender_balances.get(e.paid_by.name, 0.0) + e.amount
        top_spender = max(spender_balances.items(), key=lambda x: x[1]) if spender_balances else ("None", 0.0)
        avg_expense = total / len(self.manager.get_expenses()) if self.manager.get_expenses() else 0.0

        stats_row = ft.Row(
            [
                self.get_stat_card("Top Spender", top_spender[0], f"${top_spender[1]:.2f}"),
                self.get_stat_card("Avg Expense", f"${avg_expense:.2f}", f"{len(self.manager.get_expenses())} items"),
            ],
            alignment=ft.MainAxisAlignment.SPACE_AROUND
        )

        category_progress = []
        cat_icons = {
            Category.GROCERIES: ft.icons.SHOPPING_CART,
            Category.UTILITIES: ft.icons.LIGHTBULB,
            Category.HOUSEHOLD: ft.icons.HOME,
            Category.FOOD_DELIVERY: ft.icons.PEDAL_BIKE,
            Category.OTHER: ft.icons.INBOX,
        }

        for cat, amount in sorted(spending.items(), key=lambda x: x[1], reverse=True):
            if amount == 0: continue
            percentage = amount / total
            icon = cat_icons.get(cat, ft.icons.INBOX)
            category_progress.append(
                ft.Column(
                    [
                        ft.Row(
                            [
                                ft.Row([ft.Icon(icon, size=16), ft.Text(cat.value)]), 
                                ft.Text(f"${amount:.2f} ({percentage:.1%})", weight=ft.FontWeight.BOLD)
                            ], 
                            alignment=ft.MainAxisAlignment.SPACE_BETWEEN
                        ),
                        ft.ProgressBar(value=percentage, color=ft.colors.GREEN, bgcolor=ft.colors.SURFACE_CONTAINER, height=8, border_radius=4),
                        ft.Container(height=5),
                    ]
                )
            )

        return ft.Column(
            scroll=ft.ScrollMode.AUTO,
            controls=[
                ft.Text("Spending Statistics", size=20, weight=ft.FontWeight.BOLD),
                stats_row,
                ft.Divider(),
                ft.Text("By Category", size=20, weight=ft.FontWeight.BOLD),
                *category_progress
            ]
        )

    def get_stat_card(self, title, main_val, sub_val):
        return ft.Card(
            content=ft.Container(
                content=ft.Column(
                    [
                        ft.Text(title, size=12),
                        ft.Text(main_val, size=18, weight=ft.FontWeight.BOLD),
                        ft.Text(sub_val, size=12),
                    ],
                    horizontal_alignment=ft.CrossAxisAlignment.CENTER,
                ),
                padding=10,
                width=150,
            )
        )

    # --- ACTIONS & DIALOGS ---

    def on_expense_search(self, e):
        query = e.control.value.lower()
        expenses = [e for e in self.manager.get_expenses() if query in e.description.lower() or query in e.category.value.lower()]
        self.render_expense_list(sorted(expenses, key=lambda x: x.date, reverse=True))

    def add_member(self, _):
        name = self.member_name_field.value.strip()
        if not name: return
        
        # Check for duplicate names
        if any(m.name.lower() == name.lower() for m in self.group.members):
            self.show_snackbar("Member already exists!")
            return

        new_user = User(name=name)
        self.group.members.append(new_user)
        self.repository.save()
        self.member_name_field.value = ""
        self.refresh_view()

    def delete_member(self, user_id):
        self.group.members[:] = [m for m in self.group.members if m.id != user_id]
        self.repository.save()
        self.refresh_view()

    def show_add_expense_dialog(self, _):
        if not self.group.members:
            self.show_snackbar("Add members first!")
            return

        desc_field = ft.TextField(label="Description")
        amount_field = ft.TextField(label="Amount", keyboard_type=ft.KeyboardType.NUMBER)
        paid_by_dd = ft.Dropdown(
            label="Paid By",
            options=[ft.dropdown.Option(m.name) for m in self.group.members],
            value=self.group.members[0].name
        )
        cat_dd = ft.Dropdown(
            label="Category",
            options=[ft.dropdown.Option(c.value) for c in Category],
            value=Category.OTHER.value
        )
        
        participant_checks = [ft.Checkbox(label=m.name, value=True) for m in self.group.members]
        
        def save_expense(_):
            try:
                desc = desc_field.value.strip()
                amount = float(amount_field.value)
                paid_by_name = paid_by_dd.value
                category = Category(cat_dd.value)
                
                paid_by = next(m for m in self.group.members if m.name == paid_by_name)
                participants = [m for m, cb in zip(self.group.members, participant_checks) if cb.value]
                
                if not desc or amount <= 0 or not participants:
                    raise ValueError("Invalid input")
                
                self.manager.add_equal_expense(desc, amount, paid_by, participants, category)
                self.repository.save()
                self.page.pop_dialog()
                self.refresh_view()
            except Exception as e:
                self.show_snackbar(f"Error: {e}")

        dialog = ft.AlertDialog(
            title=ft.Text("Add Expense"),
            content=ft.Column(
                [
                    desc_field, amount_field, paid_by_dd, cat_dd,
                    ft.Text("Participants", weight=ft.FontWeight.BOLD),
                    ft.Column(participant_checks, scroll=ft.ScrollMode.AUTO, height=100)
                ],
                tight=True,
                width=300
            ),
            actions=[
                ft.TextButton("Cancel", on_click=lambda _: self.page.pop_dialog()),
                ft.ElevatedButton("Save", on_click=save_expense)
            ],
        )
        self.page.show_dialog(dialog)

    def settle_selected(self, _):
        if not hasattr(self, "settlement_radios") or self.settlement_radios.value is None:
            return
        
        idx = int(self.settlement_radios.value)
        settlements = self.manager.get_simplified_debts()
        if idx < len(settlements):
            s = settlements[idx]
            self.manager.add_settlement(s.from_user, s.to_user, s.amount)
            self.repository.save()
            self.refresh_view()

    def show_manual_settlement_dialog(self, _):
        if len(self.group.members) < 2: return
        
        from_dd = ft.Dropdown(label="From", options=[ft.dropdown.Option(m.name) for m in self.group.members])
        to_dd = ft.Dropdown(label="To", options=[ft.dropdown.Option(m.name) for m in self.group.members])
        amount_field = ft.TextField(label="Amount", keyboard_type=ft.KeyboardType.NUMBER)
        
        def save_settlement(_):
            try:
                f_name = from_dd.value
                t_name = to_dd.value
                amount = float(amount_field.value)
                if f_name == t_name or amount <= 0: raise ValueError()
                
                f_user = next(m for m in self.group.members if m.name == f_name)
                t_user = next(m for m in self.group.members if m.name == t_name)
                
                self.manager.add_settlement(f_user, t_user, amount)
                self.repository.save()
                self.page.pop_dialog()
                self.refresh_view()
            except:
                pass

        dialog = ft.AlertDialog(
            title=ft.Text("Record Payment"),
            content=ft.Column([from_dd, to_dd, amount_field], tight=True),
            actions=[
                ft.TextButton("Cancel", on_click=lambda _: self.page.pop_dialog()),
                ft.ElevatedButton("Save", on_click=save_settlement)
            ]
        )
        self.page.show_dialog(dialog)

    def show_new_group_dialog(self, _):
        name_field = ft.TextField(label="Group Name")
        def create(_):
            if name_field.value.strip():
                new_group = self.repository.create_group(name_field.value.strip())
                self.group = new_group
                self.manager = self.repository.get_group_manager(new_group.id)
                self.update_drawer_groups()
                self.page.pop_dialog()
                self.refresh_view()
        
        dialog = ft.AlertDialog(
            title=ft.Text("New Group"),
            content=name_field,
            actions=[ft.TextButton("Cancel", on_click=lambda _: self.page.pop_dialog()), ft.ElevatedButton("Create", on_click=create)]
        )
        self.page.show_dialog(dialog)

    def show_rename_group_dialog(self, _):
        name_field = ft.TextField(label="Group Name", value=self.group.name)
        def save(_):
            new_name = name_field.value.strip()
            if new_name:
                # Group is a frozen dataclass, but repository.persistence handles it by saving the list of managers
                # Actually Group is frozen=True in models.py.
                # I need to create a new Group object or use __dict__ if I want to hack it.
                # Wait, models.py says: @dataclass(frozen=True) class Group: ...
                # If it's frozen, I cannot change .name.
                # I should replace the group object in the manager.
                from splitmates.model.models import Group as GroupModel
                new_group_obj = GroupModel(name=new_name, id=self.group.id, members=self.group.members)
                self.manager.group = new_group_obj
                self.group = new_group_obj
                self.repository.save()
                self.update_drawer_groups()
                self.page.pop_dialog()
                self.refresh_view()
        
        dialog = ft.AlertDialog(
            title=ft.Text("Rename Group"),
            content=name_field,
            actions=[ft.TextButton("Cancel", on_click=lambda _: self.page.pop_dialog()), ft.ElevatedButton("Save", on_click=save)]
        )
        self.page.show_dialog(dialog)

    def show_delete_confirmation(self):
        def delete(_):
            self.repository.delete_group(self.group.id)
            groups = self.repository.get_all_groups()
            if not groups:
                self.group = self.repository.create_group("My Shared Expenses")
            else:
                self.group = groups[0]
            self.manager = self.repository.get_group_manager(self.group.id)
            self.update_drawer_groups()
            self.page.pop_dialog()
            self.refresh_view()

        dialog = ft.AlertDialog(
            title=ft.Text("Delete Group?"),
            content=ft.Text(f"Are you sure you want to delete '{self.group.name}'?"),
            actions=[ft.TextButton("Cancel", on_click=lambda _: self.page.pop_dialog()), ft.ElevatedButton("Delete", bgcolor=ft.colors.RED, color=ft.colors.WHITE, on_click=delete)]
        )
        self.page.show_dialog(dialog)

    def delete_expense_event(self, expense_id):
        self.manager.remove_expense(expense_id)
        self.repository.save()
        self.refresh_view()

    def export_expenses_csv(self, _):
        filename = f"expenses_{self.group.name.replace(' ', '_')}.csv"
        try:
            with open(filename, 'w', newline='', encoding='utf-8') as f:
                writer = csv.writer(f)
                writer.writerow(["Date", "Description", "Amount", "Paid By", "Category"])
                for e in self.manager.get_expenses():
                    date_str = datetime.datetime.fromtimestamp(e.date).strftime("%Y-%m-%d %H:%M")
                    writer.writerow([date_str, e.description, f"{e.amount:.2f}", e.paid_by.name, e.category.value])
            
            self.show_snackbar(f"Exported to {filename}")
        except Exception as ex:
            self.show_snackbar(f"Export failed: {ex}")
        self.page.update()

def main(page: ft.Page):
    SplitMatesFletGUI(page)

if __name__ == "__main__":
    ft.run(main)

