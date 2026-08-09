using System.Windows;
using WpfUserControl = System.Windows.Controls.UserControl;

namespace CoachBuild.Desktop.Web;

public partial class WebView2FallbackView : WpfUserControl
{
    public WebView2FallbackView()
    {
        InitializeComponent();
    }

    public event EventHandler? RepairRequested;

    public string Message
    {
        get => MessageText.Text;
        set => MessageText.Text = value;
    }

    public bool IsRepairEnabled
    {
        get => RepairButton.IsEnabled;
        set => RepairButton.IsEnabled = value;
    }

    private void OnRepairClick(object sender, RoutedEventArgs e)
    {
        RepairRequested?.Invoke(this, EventArgs.Empty);
    }
}
