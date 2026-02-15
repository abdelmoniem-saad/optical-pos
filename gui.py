import tkinter as tk
import customtkinter as ctk
from tkinter import messagebox
from splitmates.model.models import User, Category, Split
from splitmates.repository.group_repository import GroupRepository
from uuid import UUID
import datetime

# Configure appearance
ctk.set_appearance_mode("System")  # Modes: "System" (standard), "Dark", "Light"
ctk.set_default_color_theme("green")  # Themes: "blue" (standard), "green", "dark-blue"

class SplitMatesGUI:
    def __init__(self, root):
        self.root = root
        self.root.title("SplitMates")
        self.root.geometry("1100x700")

        # Initialize Data
        self.repository = GroupRepository()
        groups = self.repository.get_all_groups()
        if groups:
            self.group = groups[0]
        else:
            self.group = self.repository.create_group("My Shared Expenses")
        
        self.manager = self.repository.get_group_manager(self.group.id)

        # UI State
        self.active_tab = "Summary"
        self.participant_vars = {}

        self.setup_ui()
        self.refresh_all()

    def setup_ui(self):
        # Configure grid layout (1x2)
        self.root.grid_columnconfigure(1, weight=1)
        self.root.grid_rowconfigure(0, weight=1)

        # Create sidebar frame with widgets
        self.sidebar_frame = ctk.CTkFrame(self.root, width=200, corner_radius=0)
        self.sidebar_frame.grid(row=0, column=0, sticky="nsew")
        self.sidebar_frame.grid_rowconfigure(4, weight=1)

        self.logo_label = ctk.CTkLabel(self.sidebar_frame, text="SplitMates", font=ctk.CTkFont(size=24, weight="bold"))
        self.logo_label.grid(row=0, column=0, padx=20, pady=(20, 10))

        self.summary_button = ctk.CTkButton(self.sidebar_frame, text="Summary", command=lambda: self.select_tab("Summary"))
        self.summary_button.grid(row=1, column=0, padx=20, pady=10)

        self.expenses_button = ctk.CTkButton(self.sidebar_frame, text="Expenses", command=lambda: self.select_tab("Expenses"))
        self.expenses_button.grid(row=2, column=0, padx=20, pady=10)

        self.members_button = ctk.CTkButton(self.sidebar_frame, text="Members", command=lambda: self.select_tab("Members"))
        self.members_button.grid(row=3, column=0, padx=20, pady=10)

        self.analytics_button = ctk.CTkButton(self.sidebar_frame, text="Analytics", command=lambda: self.select_tab("Analytics"))
        self.analytics_button.grid(row=4, column=0, padx=20, pady=10)

        # Appearance mode and scaling
        self.appearance_mode_label = ctk.CTkLabel(self.sidebar_frame, text="Appearance Mode:", anchor="w")
        self.appearance_mode_label.grid(row=5, column=0, padx=20, pady=(10, 0))
        self.appearance_mode_optionemenu = ctk.CTkOptionMenu(self.sidebar_frame, values=["Light", "Dark", "System"],
                                                                       command=self.change_appearance_mode_event)
        self.appearance_mode_optionemenu.grid(row=6, column=0, padx=20, pady=(10, 10))
        self.appearance_mode_optionemenu.set("System")

        # Main Content Area
        self.main_content = ctk.CTkFrame(self.root, corner_radius=0, fg_color="transparent")
        self.main_content.grid(row=0, column=1, sticky="nsew", padx=20, pady=20)
        self.main_content.grid_columnconfigure(0, weight=1)
        self.main_content.grid_rowconfigure(1, weight=1)

        # Top Header in Main Content
        self.header_frame = ctk.CTkFrame(self.main_content, fg_color="transparent")
        self.header_frame.grid(row=0, column=0, sticky="ew", pady=(0, 20))
        
        self.tab_title = ctk.CTkLabel(self.header_frame, text="Summary", font=ctk.CTkFont(size=28, weight="bold"))
        self.tab_title.pack(side="left")

        # Group Selector
        self.group_frame = ctk.CTkFrame(self.header_frame, fg_color="transparent")
        self.group_frame.pack(side="right")
        
        self.group_var = tk.StringVar(value=self.group.name)
        self.group_cb = ctk.CTkOptionMenu(self.group_frame, values=[g.name for g in self.repository.get_all_groups()],
                                         command=self.on_group_switch)
        self.group_cb.pack(side="left", padx=5)
        
        self.new_group_btn = ctk.CTkButton(self.group_frame, text="+", width=40, command=self.create_new_group)
        self.new_group_btn.pack(side="left", padx=5)

        self.delete_group_btn = ctk.CTkButton(self.group_frame, text="🗑", width=40, fg_color="transparent", 
                                             text_color=("gray20", "gray80"), hover_color=("gray70", "gray30"),
                                             command=self.delete_current_group)
        self.delete_group_btn.pack(side="left", padx=5)

        # Create Tab Frames
        self.tab_frames = {}
        for tab_name in ["Summary", "Expenses", "Members", "Analytics"]:
            frame = ctk.CTkFrame(self.main_content, fg_color="transparent")
            self.tab_frames[tab_name] = frame

        self.setup_summary_tab()
        self.setup_expenses_tab()
        self.setup_members_tab()
        self.setup_analytics_tab()

        self.select_tab("Summary")

    def select_tab(self, name):
        self.active_tab = name
        self.tab_title.configure(text=name)
        
        # Update button styles
        buttons = [self.summary_button, self.expenses_button, self.members_button, self.analytics_button]
        tabs = ["Summary", "Expenses", "Members", "Analytics"]
        for btn, tab in zip(buttons, tabs):
            if tab == name:
                btn.configure(fg_color=("gray75", "gray25"))
            else:
                btn.configure(fg_color="transparent")

        # Hide all frames and show active
        for frame in self.tab_frames.values():
            frame.grid_forget()
        
        self.tab_frames[name].grid(row=1, column=0, sticky="nsew")
        self.refresh_all()

    def change_appearance_mode_event(self, new_appearance_mode: str):
        ctk.set_appearance_mode(new_appearance_mode)

    # --- TAB SETUPS ---

    def setup_summary_tab(self):
        frame = self.tab_frames["Summary"]
        frame.grid_columnconfigure((0, 1), weight=1)
        frame.grid_rowconfigure(1, weight=1)

        # Overview Card
        self.overview_card = ctk.CTkFrame(frame, height=120)
        self.overview_card.grid(row=0, column=0, columnspan=2, sticky="ew", pady=(0, 20))
        
        self.total_balance_label = ctk.CTkLabel(self.overview_card, text="Total Group Balance", font=ctk.CTkFont(size=14))
        self.total_balance_label.pack(pady=(15, 0))
        
        self.total_amount_label = ctk.CTkLabel(self.overview_card, text="$0.00", font=ctk.CTkFont(size=36, weight="bold"))
        self.total_amount_label.pack(pady=(0, 15))

        # Balances List (Left)
        self.balances_frame = ctk.CTkScrollableFrame(frame, label_text="Member Balances")
        self.balances_frame.grid(row=1, column=0, sticky="nsew", padx=(0, 10))

        # Settlements List (Right)
        self.settlements_frame = ctk.CTkScrollableFrame(frame, label_text="Suggested Settlements")
        self.settlements_frame.grid(row=1, column=1, sticky="nsew", padx=(10, 0))

        # Bottom Actions
        self.summary_actions = ctk.CTkFrame(frame, fg_color="transparent")
        self.summary_actions.grid(row=2, column=0, columnspan=2, sticky="ew", pady=(20, 0))
        
        self.settle_btn = ctk.CTkButton(self.summary_actions, text="Mark Selected as Paid", command=self.settle_selected)
        self.settle_btn.pack(side="right", padx=5)
        
        self.manual_settle_btn = ctk.CTkButton(self.summary_actions, text="Record Custom Payment", command=self.show_manual_settlement_dialog)
        self.manual_settle_btn.pack(side="right", padx=5)

    def setup_expenses_tab(self):
        frame = self.tab_frames["Expenses"]
        frame.grid_columnconfigure(0, weight=1)
        frame.grid_rowconfigure(1, weight=1)

        # Top Bar
        top_bar = ctk.CTkFrame(frame, fg_color="transparent")
        top_bar.grid(row=0, column=0, sticky="ew", pady=(0, 10))
        
        ctk.CTkLabel(top_bar, text="Recent Transactions", font=ctk.CTkFont(size=18, weight="bold")).pack(side="left")
        
        self.expense_search_var = tk.StringVar()
        self.expense_search_var.trace_add("write", lambda *args: self.refresh_expenses())
        self.search_entry = ctk.CTkEntry(top_bar, placeholder_text="Search expenses...", 
                                        textvariable=self.expense_search_var, width=250)
        self.search_entry.pack(side="left", padx=20)

        self.export_btn = ctk.CTkButton(top_bar, text="Export CSV", width=100, fg_color="gray", 
                                       command=self.export_expenses_csv)
        self.export_btn.pack(side="right", padx=10)

        self.add_expense_btn = ctk.CTkButton(top_bar, text="+ Add Expense", width=120, command=self.show_add_expense_dialog)
        self.add_expense_btn.pack(side="right")

        # Expense List
        self.expense_list_frame = ctk.CTkScrollableFrame(frame)
        self.expense_list_frame.grid(row=1, column=0, sticky="nsew")

    def setup_members_tab(self):
        frame = self.tab_frames["Members"]
        frame.grid_columnconfigure(0, weight=1)
        frame.grid_rowconfigure(1, weight=1)

        # Add Member Section
        add_frame = ctk.CTkFrame(frame)
        add_frame.grid(row=0, column=0, sticky="ew", pady=(0, 20), padx=2)
        
        self.member_name_entry = ctk.CTkEntry(add_frame, placeholder_text="Enter member name...", width=300)
        self.member_name_entry.pack(side="left", padx=20, pady=20)
        self.member_name_entry.bind("<Return>", lambda e: self.add_member())

        self.add_member_btn = ctk.CTkButton(add_frame, text="Add Member", command=self.add_member)
        self.add_member_btn.pack(side="left", padx=(0, 20), pady=20)

        # Members List
        self.members_list_frame = ctk.CTkScrollableFrame(frame, label_text="Group Members")
        self.members_list_frame.grid(row=1, column=0, sticky="nsew")

    def setup_analytics_tab(self):
        frame = self.tab_frames["Analytics"]
        frame.grid_columnconfigure(0, weight=1)
        frame.grid_rowconfigure(0, weight=1)

        self.analytics_scroll = ctk.CTkScrollableFrame(frame, label_text="Spending Breakdown")
        self.analytics_scroll.grid(row=0, column=0, sticky="nsew")

    # --- REFRESH LOGIC ---

    def refresh_all(self):
        self.update_group_list()
        if self.active_tab == "Summary":
            self.refresh_summary()
        elif self.active_tab == "Expenses":
            self.refresh_expenses()
        elif self.active_tab == "Members":
            self.refresh_members()
        elif self.active_tab == "Analytics":
            self.refresh_analytics()

    def update_group_list(self):
        groups = self.repository.get_all_groups()
        self.group_cb.configure(values=[g.name for g in groups])
        self.group_var.set(self.group.name)

    def refresh_summary(self):
        # Clear previous
        for widget in self.balances_frame.winfo_children():
            widget.destroy()
        for widget in self.settlements_frame.winfo_children():
            widget.destroy()

        balances = self.manager.get_balances()
        total_spent = sum(e.amount for e in self.manager.get_expenses())
        self.total_amount_label.configure(text=f"${total_spent:,.2f}")

        # Balance Cards
        if not balances:
            ctk.CTkLabel(self.balances_frame, text="No active balances").pack(pady=20)
        else:
            for user, balance in balances.items():
                card = ctk.CTkFrame(self.balances_frame, fg_color=("gray90", "gray15"))
                card.pack(fill="x", pady=5, padx=5)
                
                initials = "".join([n[0] for n in user.name.split()])[:2].upper()
                avatar = ctk.CTkLabel(card, text=initials, width=40, height=40, corner_radius=20, 
                                     fg_color="green", text_color="white", font=ctk.CTkFont(weight="bold"))
                avatar.pack(side="left", padx=10, pady=10)
                
                name_label = ctk.CTkLabel(card, text=user.name, font=ctk.CTkFont(size=14, weight="bold"))
                name_label.pack(side="left", padx=5)
                
                amount_color = "green" if balance >= 0 else "#E74C3C"
                status_text = f"{'is owed' if balance >= 0 else 'owes'} ${abs(balance):.2f}"
                status_label = ctk.CTkLabel(card, text=status_text, text_color=amount_color)
                status_label.pack(side="right", padx=15)

        # Settlement Cards
        settlements = self.manager.get_simplified_debts()
        if not settlements:
            ctk.CTkLabel(self.settlements_frame, text="All settled up! \u2728").pack(pady=20)
        else:
            self.settlement_radios = []
            self.settlement_var = tk.IntVar(value=-1)
            for i, s in enumerate(settlements):
                card = ctk.CTkFrame(self.settlements_frame, fg_color=("gray90", "gray15"))
                card.pack(fill="x", pady=5, padx=5)
                
                rb = ctk.CTkRadioButton(card, text=f"{s.from_user.name} \u2192 {s.to_user.name}", 
                                       variable=self.settlement_var, value=i)
                rb.pack(side="left", padx=10, pady=10)
                
                ctk.CTkLabel(card, text=f"${abs(s.amount):.2f}", font=ctk.CTkFont(weight="bold")).pack(side="right", padx=15)

    def refresh_expenses(self):
        for widget in self.expense_list_frame.winfo_children():
            widget.destroy()
        
        search_query = self.expense_search_var.get().lower()
        expenses = sorted(self.manager.get_expenses(), key=lambda x: x.date, reverse=True)
        
        if search_query:
            expenses = [e for e in expenses if search_query in e.description.lower() or search_query in e.category.value.lower()]

        if not expenses:
            msg = "No matching expenses." if search_query else "No expenses recorded yet."
            ctk.CTkLabel(self.expense_list_frame, text=msg).pack(pady=40)
            return

        for e in expenses:
            card = ctk.CTkFrame(self.expense_list_frame)
            card.pack(fill="x", pady=5, padx=5)
            
            # Left: Date & Category Icon
            date_str = datetime.datetime.fromtimestamp(e.date).strftime("%b %d")
            info_frame = ctk.CTkFrame(card, fg_color="transparent")
            info_frame.pack(side="left", padx=15, pady=10)
            
            ctk.CTkLabel(info_frame, text=date_str, font=ctk.CTkFont(size=12)).pack()
            
            cat_emoji = {
                Category.GROCERIES: "\U0001F6D2",
                Category.UTILITIES: "\U0001F4A1",
                Category.HOUSEHOLD: "\U0001F3E0",
                Category.FOOD_DELIVERY: "\U0001F6B4",
                Category.OTHER: "\U0001F4E6"
            }.get(e.category, "\U0001F4E6")
            
            ctk.CTkLabel(card, text=cat_emoji, font=ctk.CTkFont(size=24)).pack(side="left", padx=5)
            
            # Center: Description & Paid by
            details_frame = ctk.CTkFrame(card, fg_color="transparent")
            details_frame.pack(side="left", padx=10, fill="y")
            
            ctk.CTkLabel(details_frame, text=e.description, font=ctk.CTkFont(size=15, weight="bold"), anchor="w").pack(fill="x")
            ctk.CTkLabel(details_frame, text=f"Paid by {e.paid_by.name}", font=ctk.CTkFont(size=12), anchor="w").pack(fill="x")
            
            # Right: Amount & Delete
            right_frame = ctk.CTkFrame(card, fg_color="transparent")
            right_frame.pack(side="right", padx=10)
            
            ctk.CTkLabel(right_frame, text=f"${e.amount:.2f}", font=ctk.CTkFont(size=16, weight="bold")).pack(side="left", padx=10)
            
            del_btn = ctk.CTkButton(right_frame, text="\U0001F5D1", width=30, fg_color="#E74C3C", hover_color="#C0392B",
                                   command=lambda eid=e.id: self.delete_expense_event(eid))
            del_btn.pack(side="left")

    def refresh_members(self):
        for widget in self.members_list_frame.winfo_children():
            widget.destroy()
        
        for member in self.group.members:
            card = ctk.CTkFrame(self.members_list_frame)
            card.pack(fill="x", pady=5, padx=5)
            
            initials = "".join([n[0] for n in member.name.split()])[:2].upper()
            avatar = ctk.CTkLabel(card, text=initials, width=40, height=40, corner_radius=20, 
                                 fg_color="gray", text_color="white", font=ctk.CTkFont(weight="bold"))
            avatar.pack(side="left", padx=15, pady=10)
            
            ctk.CTkLabel(card, text=member.name, font=ctk.CTkFont(size=16)).pack(side="left", padx=5)

    def refresh_analytics(self):
        for widget in self.analytics_scroll.winfo_children():
            widget.destroy()
        
        spending = self.manager.get_category_spending()
        total = sum(spending.values())
        
        if total == 0:
            ctk.CTkLabel(self.analytics_scroll, text="Add some expenses to see analytics!").pack(pady=40)
            return
        
        # Summary Header
        header = ctk.CTkFrame(self.analytics_scroll, fg_color="transparent")
        header.pack(fill="x", pady=20, padx=20)
        ctk.CTkLabel(header, text="Spending by Category", font=ctk.CTkFont(size=20, weight="bold")).pack(side="left")
        ctk.CTkLabel(header, text=f"Total: ${total:.2f}", font=ctk.CTkFont(size=20)).pack(side="right")

        # Stats Cards
        stats_frame = ctk.CTkFrame(self.analytics_scroll, fg_color="transparent")
        stats_frame.pack(fill="x", padx=20, pady=(0, 20))
        
        # Top Spender
        spender_balances = {}
        for e in self.manager.get_expenses():
            spender_balances[e.paid_by.name] = spender_balances.get(e.paid_by.name, 0.0) + e.amount
        
        top_spender = max(spender_balances.items(), key=lambda x: x[1]) if spender_balances else ("None", 0.0)
        
        spender_card = ctk.CTkFrame(stats_frame)
        spender_card.pack(side="left", expand=True, fill="both", padx=(0, 10))
        ctk.CTkLabel(spender_card, text="Top Spender", font=ctk.CTkFont(size=12)).pack(pady=(10, 0))
        ctk.CTkLabel(spender_card, text=f"{top_spender[0]}", font=ctk.CTkFont(size=18, weight="bold")).pack()
        ctk.CTkLabel(spender_card, text=f"${top_spender[1]:.2f}", font=ctk.CTkFont(size=12)).pack(pady=(0, 10))

        # Avg Expense
        avg_expense = total / len(self.manager.get_expenses()) if self.manager.get_expenses() else 0.0
        avg_card = ctk.CTkFrame(stats_frame)
        avg_card.pack(side="left", expand=True, fill="both", padx=10)
        ctk.CTkLabel(avg_card, text="Avg. Expense", font=ctk.CTkFont(size=12)).pack(pady=(10, 0))
        ctk.CTkLabel(avg_card, text=f"${avg_expense:.2f}", font=ctk.CTkFont(size=18, weight="bold")).pack()
        ctk.CTkLabel(avg_card, text=f"{len(self.manager.get_expenses())} items", font=ctk.CTkFont(size=12)).pack(pady=(0, 10))

        # Member Count
        member_card = ctk.CTkFrame(stats_frame)
        member_card.pack(side="left", expand=True, fill="both", padx=(10, 0))
        ctk.CTkLabel(member_card, text="Group Members", font=ctk.CTkFont(size=12)).pack(pady=(10, 0))
        ctk.CTkLabel(member_card, text=f"{len(self.group.members)}", font=ctk.CTkFont(size=18, weight="bold")).pack()
        ctk.CTkLabel(member_card, text="Active", font=ctk.CTkFont(size=12)).pack(pady=(0, 10))

        # Category Bars
        sorted_spending = sorted(spending.items(), key=lambda x: x[1], reverse=True)
        
        for cat, amount in sorted_spending:
            if amount == 0: continue
            
            percentage = amount / total
            
            cat_frame = ctk.CTkFrame(self.analytics_scroll)
            cat_frame.pack(fill="x", pady=10, padx=20)
            
            top_line = ctk.CTkFrame(cat_frame, fg_color="transparent")
            top_line.pack(fill="x", padx=15, pady=(10, 5))
            
            cat_emoji = {
                Category.GROCERIES: "\U0001F6D2",
                Category.UTILITIES: "\U0001F4A1",
                Category.HOUSEHOLD: "\U0001F3E0",
                Category.FOOD_DELIVERY: "\U0001F6B4",
                Category.OTHER: "\U0001F4E6"
            }.get(cat, "\U0001F4E6")

            ctk.CTkLabel(top_line, text=f"{cat_emoji} {cat.value}", font=ctk.CTkFont(size=14, weight="bold")).pack(side="left")
            ctk.CTkLabel(top_line, text=f"${amount:.2f} ({percentage:.1%})").pack(side="right")
            
            progress = ctk.CTkProgressBar(cat_frame)
            progress.pack(fill="x", padx=15, pady=(0, 15))
            progress.set(percentage)

    def export_expenses_csv(self):
        import csv
        from tkinter import filedialog
        
        filename = filedialog.asksaveasfilename(
            defaultextension=".csv",
            filetypes=[("CSV files", "*.csv")],
            initialfile=f"{self.group.name}_expenses.csv"
        )
        
        if filename:
            try:
                with open(filename, 'w', newline='', encoding='utf-8') as f:
                    writer = csv.writer(f)
                    writer.writerow(["Date", "Description", "Amount", "Category", "Paid By"])
                    for e in sorted(self.manager.get_expenses(), key=lambda x: x.date):
                        date_str = datetime.datetime.fromtimestamp(e.date).strftime("%Y-%m-%d %H:%M")
                        writer.writerow([date_str, e.description, e.amount, e.category.value, e.paid_by.name])
                messagebox.showinfo("Success", f"Expenses exported to {filename}")
            except Exception as ex:
                messagebox.showerror("Error", f"Failed to export: {ex}")

    # --- ACTIONS ---

    def on_group_switch(self, group_name):
        groups = self.repository.get_all_groups()
        selected = next((g for g in groups if g.name == group_name), None)
        if selected:
            self.group = selected
            self.manager = self.repository.get_group_manager(self.group.id)
            self.refresh_all()

    def create_new_group(self):
        dialog = ctk.CTkInputDialog(text="Enter group name:", title="New Group")
        name = dialog.get_input()
        if name:
            if any(g.name == name for g in self.repository.get_all_groups()):
                messagebox.showwarning("Warning", "Group already exists")
                return
            self.group = self.repository.create_group(name)
            self.manager = self.repository.get_group_manager(self.group.id)
            self.update_group_list()
            self.refresh_all()

    def delete_current_group(self):
        if len(self.repository.get_all_groups()) <= 1:
            from tkinter import messagebox
            messagebox.showwarning("Warning", "Cannot delete the only group. Create another group first.")
            return
            
        from tkinter import messagebox
        if messagebox.askyesno("Delete Group", f"Are you sure you want to delete '{self.group.name}'? All data will be lost."):
            self.repository.delete_group(self.group.id)
            all_groups = self.repository.get_all_groups()
            self.group = all_groups[0]
            self.manager = self.repository.get_group_manager(self.group.id)
            self.group_var.set(self.group.name)
            self.update_group_list()
            self.refresh_all()

    def add_member(self):
        name = self.member_name_entry.get().strip()
        if not name: return
        if any(m.name.lower() == name.lower() for m in self.group.members):
            messagebox.showwarning("Warning", "Member already exists")
            return
        
        user = User(name=name)
        self.group.members.append(user)
        self.repository.save()
        self.member_name_entry.delete(0, tk.END)
        self.refresh_all()

    def delete_expense_event(self, expense_id):
        if messagebox.askyesno("Confirm", "Delete this expense?"):
            self.manager.remove_expense(expense_id)
            self.repository.save()
            self.refresh_all()

    def settle_selected(self):
        idx = self.settlement_var.get()
        if idx == -1:
            messagebox.showwarning("Warning", "Select a settlement first")
            return
        
        suggested = self.manager.get_simplified_debts()
        if idx < len(suggested):
            s = suggested[idx]
            if messagebox.askyesno("Confirm", f"Record ${s.amount:.2f} payment from {s.from_user.name} to {s.to_user.name}?"):
                self.manager.add_settlement(s.from_user, s.to_user, abs(s.amount))
                self.repository.save()
                self.refresh_all()

    # --- DIALOGS ---

    def show_add_expense_dialog(self):
        if not self.group.members:
            messagebox.showwarning("Empty Group", "Add members first!")
            return

        dialog = ctk.CTkToplevel(self.root)
        dialog.title("Add Expense")
        dialog.geometry("500x600")
        dialog.transient(self.root)
        dialog.grab_set()

        ctk.CTkLabel(dialog, text="Add New Expense", font=ctk.CTkFont(size=20, weight="bold")).pack(pady=20)

        # Form
        form = ctk.CTkFrame(dialog, fg_color="transparent")
        form.pack(fill="both", expand=True, padx=40)

        ctk.CTkLabel(form, text="Description", anchor="w").pack(fill="x")
        desc_entry = ctk.CTkEntry(form, placeholder_text="e.g. Dinner, Rent...")
        desc_entry.pack(fill="x", pady=(0, 15))

        ctk.CTkLabel(form, text="Amount ($)", anchor="w").pack(fill="x")
        amount_entry = ctk.CTkEntry(form, placeholder_text="0.00")
        amount_entry.pack(fill="x", pady=(0, 15))

        ctk.CTkLabel(form, text="Paid By", anchor="w").pack(fill="x")
        paid_by_cb = ctk.CTkOptionMenu(form, values=[m.name for m in self.group.members])
        paid_by_cb.pack(fill="x", pady=(0, 15))

        ctk.CTkLabel(form, text="Category", anchor="w").pack(fill="x")
        cat_cb = ctk.CTkOptionMenu(form, values=[c.value for c in Category])
        cat_cb.pack(fill="x", pady=(0, 15))

        ctk.CTkLabel(form, text="Split Between", anchor="w").pack(fill="x")
        part_frame = ctk.CTkScrollableFrame(form, height=150)
        part_frame.pack(fill="x", pady=(0, 15))
        
        p_vars = {}
        for m in self.group.members:
            v = tk.BooleanVar(value=True)
            p_vars[m.id] = v
            ctk.CTkCheckBox(part_frame, text=m.name, variable=v).pack(anchor="w", pady=2)

        def save():
            desc = desc_entry.get().strip()
            try:
                amt = float(amount_entry.get())
                if amt <= 0: raise ValueError()
            except:
                messagebox.showerror("Error", "Enter valid amount")
                return
            
            payer = next(m for m in self.group.members if m.name == paid_by_cb.get())
            participants = [m for m in self.group.members if p_vars[m.id].get()]
            
            if not participants:
                messagebox.showwarning("Error", "Select at least one person")
                return
            
            cat = next(c for c in Category if c.value == cat_cb.get())
            
            self.manager.add_equal_expense(desc, amt, payer, participants, cat)
            self.repository.save()
            self.refresh_all()
            dialog.destroy()

        ctk.CTkButton(dialog, text="Record Expense", command=save, height=40).pack(pady=30)

    def show_manual_settlement_dialog(self):
        if len(self.group.members) < 2:
            messagebox.showwarning("Error", "Need at least 2 members")
            return

        dialog = ctk.CTkToplevel(self.root)
        dialog.title("Record Payment")
        dialog.geometry("400x500")
        dialog.transient(self.root)
        dialog.grab_set()

        ctk.CTkLabel(dialog, text="Record Payment", font=ctk.CTkFont(size=20, weight="bold")).pack(pady=20)
        
        form = ctk.CTkFrame(dialog, fg_color="transparent")
        form.pack(fill="both", expand=True, padx=40)

        ctk.CTkLabel(form, text="From", anchor="w").pack(fill="x")
        from_cb = ctk.CTkOptionMenu(form, values=[m.name for m in self.group.members])
        from_cb.pack(fill="x", pady=(0, 15))

        ctk.CTkLabel(form, text="To", anchor="w").pack(fill="x")
        to_cb = ctk.CTkOptionMenu(form, values=[m.name for m in self.group.members])
        to_cb.pack(fill="x", pady=(0, 15))

        ctk.CTkLabel(form, text="Amount ($)", anchor="w").pack(fill="x")
        amt_entry = ctk.CTkEntry(form)
        amt_entry.pack(fill="x", pady=(0, 15))

        def save():
            f_name, t_name = from_cb.get(), to_cb.get()
            if f_name == t_name:
                messagebox.showwarning("Error", "Cannot pay self")
                return
            try:
                amt = float(amt_entry.get())
                if amt <= 0: raise ValueError()
            except:
                messagebox.showerror("Error", "Enter valid amount")
                return
            
            u_from = next(m for m in self.group.members if m.name == f_name)
            u_to = next(m for m in self.group.members if m.name == t_name)
            
            self.manager.add_settlement(u_from, u_to, amt)
            self.repository.save()
            self.refresh_all()
            dialog.destroy()

        ctk.CTkButton(dialog, text="Record Payment", command=save, height=40).pack(pady=30)

if __name__ == "__main__":
    root = ctk.CTk()
    app = SplitMatesGUI(root)
    root.mainloop()
