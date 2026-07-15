<template>
  <main class="main-content">
    <div :class="['card', (access || accessData) ? '':'hide']">
      <div :class="['card-header', invType=='sale' ? 'bg-danger-bright' : 'bg-success-bright']">
        <h5 class="pull-right">فاکتور {{invType=='sale' ? 'فروش' : 'خرید'}} جدید</h5>
      </div>
      <div class="card-body">
        <div :class="['row', access?'':'hide']">
          <div class="col-6">
            <div class="form-group">
              <label class="col-form-label">نام مشتری:</label>
              <select id="AccountName" data-module="select2" name="AccountName"></select>
            </div>

            <div class="form-group">
              <label class="col-form-label">کد مشتری:</label>
              <input type="text" class="form-control" readonly name="AccountNumber">
            </div>
          </div>
          <div class="col-6">
            <div class="form-group">
              <label class="col-form-label">نام نماینده فروش:</label>
              <select id="SAccountName" data-module="select2" name="SAccountName"></select>
            </div>

            <div class="form-group">
              <label class="col-form-label">کد نماینده فروش:</label>
              <input type="text" class="form-control" readonly name="SAccountNumber">
            </div>
          </div>
        </div>
        <template v-if="access || accessData">
          <div v-if="!access" class="row">
            <div class="col-6">
              <div class="form-group">
                <label class="col-form-label">نام مشتری:</label>
                <label class="mr-2">{{ accessData.AccountName }}</label>
              </div>
            </div>
            <div class="col-6">
              <div class="form-group">
                <label class="col-form-label">نام نماینده فروش:</label>
                <label class="mr-2">{{ accessData.SAccountName }}</label>
              </div>
            </div>
          </div>
        </template>
        <hr>

        <div class="row">
          <div class="col-6">
            <div class="form-group">
              <label class="col-form-label">موبایل:</label>
              <input type="text" class="form-control" name="mobile">
            </div>
          </div>

          <div class="col-6">
            <div class="form-group">
              <label class="col-form-label">نام و نام خانوادگی:</label>
              <input type="text" class="form-control" name="fullname">
            </div>
          </div>
        </div>

        <div class="row">
          <div class="col-6">
            <div class="form-group">
              <label class="col-form-label">کدملی:</label>
              <input type="text" class="form-control" name="ncode">
            </div>
          </div>

          <div class="col-6">
            <div class="form-group">
              <label class="col-form-label">رفرنس:</label>
              <input type="text" class="form-control" name="GeneralRef">
            </div>
          </div>
        </div>

        <div class="row">
          <div class="col-12">
            <div class="form-group">
              <label class="col-form-label">توضیحات:</label>
              <input type="text" class="form-control" name="InvDescription">
            </div>
          </div>
        </div>

      </div>
      <div class="card-footer text-muted m-0">
        <div class="d-flex justify-content-end">
          <button class="btn btn-success" id="addToBody" data-toggle="modal" data-index="-1" data-target="#invoiceBody">افزودن ردیف جدید</button>
        </div>
      </div>

      <hr class="m-0">

      <div class="card-body p-0">
        <div class="table-responsive">
          <table class="table table-hover">
            <thead>
            <tr>
              <th width="55">ردیف</th>
              <th width="55">انبار</th>
              <th width="100">کد کالا</th>
              <th>نام کالا</th>
              <th width="55">مقدار</th>
              <th width="80">فی</th>
              <th width="80">مبلغ</th>
              <th></th>
            </tr>
            </thead>
            <tbody>
            <tr v-if="!invoiceBody.length">
              <td colspan="8" class="text-center text-muted">--- هیچ ردیفی برای فاکتور وارد نشده است ---</td>
            </tr>
            <tr v-else v-for="(item, index) of invoiceBody">
              <td>{{ index+1 }}</td>
              <td>{{ item.STNumber }}</td>
              <td class="font-en">{{ item.ItemNumber }}</td>
              <td class="font-en">{{ item.ItemName }}</td>
              <td>{{ item.Quan }}</td>
              <td>{{ number_format( item.Price ) }}</td>
              <td>{{ number_format( item.Price * item.Quan ) }}</td>
              <td class="text-left">
                <button @click="deleteItem(index)" class="btn btn-danger btn-xs ml-1"><i class="fa fa-trash"></i></button>
                <button data-toggle="modal" :data-index="index" data-target="#invoiceBody" class="btn btn-success btn-xs">ویرایش</button>
              </td>
            </tr>
            </tbody>
          </table>
        </div>
      </div>

      <div class="card-footer text-muted">
        <div class="d-flex justify-content-between">
          <div>هزینه: <span>0</span> ریال</div>
          <div>تخفیف: <span>0</span> ریال</div>
          <div>جمع کل: <span>{{ number_format(totalPrice) }}</span> ریال</div>
        </div>
      </div>

      <hr style="border: 4px solid #E7EBEE;">

      <div class="card-body p-0">
        <div class="table-responsive">
          <table class="table table-hover">
            <thead>
            <tr>
              <th width="70">ردیف</th>
              <th width="300">توضیح</th>
              <th width="170">مبلغ</th>
              <th width="150">نوع پرداخت</th>
              <th><button class="btn btn-success pull-left ml-3 btn-receipt-new" data-toggle="modal" data-target="#newReceipt">دریافتی جدید</button></th>
            </tr>
            </thead>
            <tbody>
            <tr v-if="!payList.length">
              <td colspan="8" class="text-center text-muted">--- هیچ وجه دریافتی از مشتری ثبت نگردیده است ---</td>
            </tr>
            <tr v-else v-for="(pay, index) of payList">
              <td>{{index+1}}</td>
              <td>{{pay.description}}</td>
              <td>{{number_format(pay.amount)}}</td>
              <td>{{pay.accountTitle}}</td>
              <td class="text-left">
                <button class="btn btn-danger btn-xs" @click="payList.splice(index, 1)"><i class="far fa-trash-alt"></i></button>
              </td>
            </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
    <div class="row mb-4">
      <div class="col-lg-12">
        <button @click="insertInvoice" class="btn btn-info" id="saveInvoice">ثبت نهایی فاکتور</button>
      </div>
    </div>
    <div v-if="!(access || accessData)" class="card">
      <div class="card-body">
        <div class="alert alert-danger alert-with-border m-b-0" role="alert">
          <h4 class="alert-heading">خطا!</h4>
          <p>متاسفانه در سیستم دسترسی ثبت فاکتور برای شما تعریف نگردیده است. لطفا با آقای رحمانی تماس حاصل فرمایید.</p>
        </div>
      </div>
    </div>

    <div class="modal fade" id="invoiceBody" tabindex="-1" role="dialog" aria-hidden="true">
      <div class="modal-dialog modal-dialog-centered" role="document">
        <div class="modal-content">
          <div class="modal-header">
            <h5 class="modal-title">افزودن ردیف جدید</h5>
            <button type="button" class="close" data-dismiss="modal" aria-label="بستن"><i class="ti-close"></i></button>
          </div>
          <div class="modal-body">
            <div class="form-group">
              <label class="col-form-label">نام کالا:</label>
              <select id="ItemDesc" name="ItemDesc" data-module="select2"></select>
            </div>
            <div class="form-group">
              <label class="col-form-label">کد کالا:</label>
              <input name="ItemNumber" type="text" readonly class="form-control">
            </div>
            <div class="form-group">
              <label class="col-form-label">انبار:</label>
              <select id="STNumber" name="STNumber" data-module="select2">
                <option v-for="st of stocks" :value="st.STNumber">{{ st.STNumber }} - {{ st.StDesc }} ({{ st.RemainQ }})</option>
              </select>
            </div>
            <div class="form-group">
              <label class="col-form-label">تعداد:</label>
              <input name="Quan" type="number" class="form-control" value="1" min="1" :max="stockMax">
            </div>
            <div class="form-group">
              <label class="col-form-label">قیمت:</label>
              <input name="Price" type="text" data-input-mask="money" placeholder="0" dir="ltr" class="form-control text-right">
            </div>
          </div>
          <div class="modal-footer">
            <button type="button" class="btn btn-secondary" data-dismiss="modal">بی‌خیال</button>
            <button @click="addItem" type="button" class="btn btn-primary">ثبت</button>
          </div>
        </div>
      </div>
    </div>

    <div class="modal fade" id="newReceipt" tabindex="-1" role="dialog" aria-hidden="true">
      <div class="modal-dialog modal-dialog-centered" role="document">
        <div class="modal-content">
          <div class="modal-header">
            <h5 class="modal-title">دریافتی جدید</h5>
            <button type="button" class="close" data-dismiss="modal" aria-label="بستن"><i class="ti-close"></i></button>
          </div>
          <div class="modal-body">
            <div class="form-group">
              <label class="col-form-label">مبلغ:</label>
              <input ref="amount" name="Amount" type="text" data-input-mask="money" placeholder="0" dir="ltr" class="form-control text-right">
            </div>
            <div class="form-group">
              <label class="col-form-label">رفرنس:</label>
              <input ref="refrenceNo" name="refrenceNo" type="text" class="form-control">
            </div>
            <div class="form-group">
              <label class="col-form-label">چهار رقم آخر کارت:</label>
              <input ref="lastDigitsOfCard" name="lastDigitsOfCard" type="text" class="form-control">
            </div>
            <div class="form-group">
              <label class="col-form-label">حساب:</label>
              <select ref="payType" name="PayType" data-module="select2">
                <option v-for="pt of payTypes" :value="pt.PayTypeId">{{ pt.PayTypeDesc }}</option>
              </select>
            </div>
          </div>
          <div class="modal-footer">
            <button type="button" class="btn btn-secondary" data-dismiss="modal">بی‌خیال</button>
            <button @click="addReceipt" type="button" class="btn btn-primary">ثبت</button>
          </div>
        </div>
      </div>
    </div>
  </main>
</template>

<script>
import util from '../../assets/pureFunctions';
import axios from "axios";
export default {
  data(){
    return {
      access: false,
      accessData: null,
      invoiceBody: [],
      stocks: [],
      stockMax: 1,
      number_format: util.number_format,
      totalPrice: 0,
      activeIndex: -1,
      invType: "sale",
      payTypes: [],
      payList: []
    }
  },
  methods: {
    addItem(){
      let ItemDesc = $("#ItemDesc").val();
      let ItemNumber = $("[name=ItemNumber]").val();
      let STNumber = $("#STNumber").val();
      let Quan = $("[name=Quan]").val();
      let Price = $("[name=Price]").val();
      if( !ItemDesc ) return toastr['error']("نام کالا وارد نشده است");
      if( !ItemNumber ) return toastr['error']("خطا در دریافت کد کالا");
      if( !STNumber ) return toastr['error']("انبار انتخاب نشده است");
      if( Quan <= 0 ) return toastr['error']("تعداد کالا کمتر از حد مجاز است");
      if( Quan > this.stockMax ) return toastr['error']("تعداد کالا بیشتر از حد مجاز است");
      if( Price <= 10 ) return toastr['error']("مبلغ نا معتبر");

      const item = {
        STNumber: $("#STNumber").val(),
        ItemNumber: $("[name=ItemNumber]").val(),
        ItemName: $("#ItemDesc").text(),
        Quan: $("[name=Quan]").val(),
        Price: $("[name=Price]").val().replace(/,/g, "")
      };
      if( this.activeIndex == -1 ){
        this.invoiceBody.push(item);
      }else{
        this.invoiceBody[this.activeIndex] = item;
      }

      $("#invoiceBody").modal('hide');

      this.clearModal();
      this.calcInvoiceParams();
    },
    addReceipt(){
      axios.post("https://shygun.4mk.ir/api/products/checkVoucherItems", {id: trnumToEn(this.$refs.refrenceNo.value)}).then(({data}) => {
        if( data.ok ){
          if( data.data.length ){
            toastr['error']("شماره رفرنس تکراری است.");
          }else{
            /* ثبت */
            let dataSet = {
              amount: this.$refs.amount.value.replace(/,/g, ""),
              description: `ف ف xxxx رفرنس ${trnumToEn(this.$refs.refrenceNo.value)} ش ك ${trnumToEn(this.$refs.lastDigitsOfCard.value)}`,
              account: $(this.$refs.payType).val(),
              accountTitle: $(this.$refs.payType).find("option:selected").text()
            }
            this.$refs.amount.value = '';
            this.$refs.refrenceNo.value = '';
            this.$refs.lastDigitsOfCard.value = '';

            $("#newReceipt").modal('hide');

            this.payList.push(dataSet);
            /* --------------------- */

          }
        }else{
          toastr['error']("خطا در دریافت نتیجه.");
        }
      });

    },
    deleteItem(index){
      this.invoiceBody.splice(index, 1);
      this.calcInvoiceParams();
    },
    stockOnModalSync(stId){
      $("[name=ItemNumber]").val(stId);
      axios.post("https://shygun.4mk.ir/api/stock/search", {name: stId}).then(response => {
        if( response.data && response.data.ok ){
          this.stocks = response.data.list;
          this.stockMax = response.data.list[0].RemainQ;
        }else{
          toastr['error']("خطایی در انجام عملیات رخ داده است.");
        }
      });
    },
    getAccessData(){
      axios.post('/admin/accounting/accAccessList', {user: 1}).then(({data}) => {
        if( data.ok ){
          this.accessData = data.list.length > 0 ? data.list[0] : null;
          this.getPayTypes();
        }else{
          toastr['error']("خطا در خواندن سطح دسترسی.");
        }
      });
    },
    getPayTypes(){
      axios.post('https://shygun.4mk.ir/api/products/voucher', {id: this.accessData.accUser}).then(({data}) => {
        if( data && data.ok ){
          this.payTypes = data.list;
        }else{
          toastr['error']("خطا در فراخوانی حساب‌ها.");
        }
      });
    },
    calcInvoiceParams(){
      this.totalPrice = 0;
      for(let item of this.invoiceBody){
        this.totalPrice += (item.Price * item.Quan);
      }
    },
    clearModal(){
      $("[name=ItemNumber]").val('');
      $("#ItemDesc").empty();
      $("[name=Quan]").val('1');
      $("[name=Price]").val('');
      this.stocks = [];
    },
    clearForm(){
      $("[name=AccountNumber]").val('');
      $("[name=SAccountNumber]").val('');
      $("#AccountName").empty();
      $("#SAccountName").empty();
      $("[name=GeneralRef]").val('');
      $("[name=InvDescription]").val('');
      $("[name=mobile]").val('');
      $("[name=fullname]").val('');
      $("[name=ncode]").val('');
      this.invoiceBody = [];
      this.payList = [];
    },
    insertInvoice(){
      let AccountNumber = $("[name=AccountNumber]").val();

      if( this.access && !AccountNumber ){
        toastr['error']("انتخاب نام مشتری الزامی است.");
        return null;
      }
      if( !this.invoiceBody.length  ){
        toastr['error']("هیچ ردیفی برای فاکتور درج نشده است.");
        return null;
      }

      let invoices = [];
      for( let item of this.invoiceBody ){
        invoices.push({
          STNumber: item.STNumber,
          ItemNumber: item.ItemNumber,
          Quan: item.Quan,
          Price: item.Price
        });
      }
      axios.post('/admin/accounting/putInvoice', {
        Body: invoices,
        InvTyp: this.invType=='sale' ? 2 : 3,
        InvDescription: $("[name=InvDescription]").val(),
        InvDate: new Date().echo("Ymd"),
        InvPayDue: new Date().echo("Ymd"),
        AccountNumber: $("[name=AccountNumber]").val(),
        SAccountNumber: $("[name=SAccountNumber]").val(),
        DiscAmount: 0,
        GeneralRef: $("[name=GeneralRef]").val(),
        payList: this.payList,
        fullname: $("[name=fullname]").val(),
        mobile: $("[name=mobile]").val(),
        ncode: $("[name=ncode]").val()
      }).then(({data}) => {
        if( data.ok ){
          toastr['success'](data.msg);
          this.clearModal();
          this.clearForm();
        }else{
          toastr['error'](data.error);
        }
      });
    }
  },
  created() {
    axios.post('/admin/access', {rule: "#createInvSale;"}).then(({data}) => {
      if( data.ok ){
        this.access = data.access;
      }
    })
  },
  mounted() {
    const vm = this;
    this.getAccessData();

    $(document).ready(function(){
      $('#AccountName').select2({
        minimumInputLength: 1,
        ajax: {
          url: 'https://shygun.4mk.ir/api/customerName/search',
          type: "POST",
          dataType: 'json',
          data: function (params) {
            return {
              name: params.term
            };
          },
          processResults: function (data) {
            if( data.ok ){
              return {
                results: $.map(data.list, function (item) {
                  return {
                    text: item.AccountName,
                    id: item.AccountNumber,
                    scode: item.Scode1
                  }
                })
              };
            }else{
              return {
                results: []
              };
            }
          }
        }
      });

      $('#AccountName').on('select2:select', function (e) {
        var data = e.params.data;
        $("[name=AccountNumber]").val(data.id);
        if( vm.invType == "sale" ){
          axios.post('https://shygun.4mk.ir/api/customerName/search', {name: `:${data.scode}`}).then(({data}) => {
            if( data && data.ok ){
              $("#SAccountName").empty();
              $('#SAccountName').append( new Option(data.list[0].AccountName, data.list[0].AccountNumber, false, false) ).trigger('change');
              $("[name=SAccountNumber]").val(data.list[0].AccountNumber);
            }
          });
        }
      });

      $('#SAccountName').select2({
        minimumInputLength: 1,
        ajax: {
          url: 'https://shygun.4mk.ir/api/customerName/search',
          type: "POST",
          dataType: 'json',
          data: function (params) {
            return {
              name: params.term
            };
          },
          processResults: function (data) {
            if( data.ok ){
              return {
                results: $.map(data.list, function (item) {
                  return {
                    text: item.AccountName,
                    id: item.AccountNumber
                  }
                })
              };
            }else{
              return {
                results: []
              };
            }
          }
        }
      });

      $('#SAccountName').on('select2:select', function (e) {
        var data = e.params.data;
        $("[name=SAccountNumber]").val(data.id);
      });

      $('#ItemDesc').select2({
        minimumInputLength: 1,
        ajax: {
          url: 'https://shygun.4mk.ir/api/stock/search',
          type: "POST",
          dataType: 'json',
          data: function (params) {
            return {
              name: params.term,
              group: 1
            };
          },
          processResults: function (data) {
            if( data.ok ){
              return {
                results: $.map(data.list, function (item) {
                  return {
                    text: item.ItemDesc + ' (' + item.RemainQ + ')',
                    id: item.ItemCode
                  }
                })
              };
            }else{
              return {
                results: []
              };
            }
          }
        }
      });

      $('#ItemDesc').on('select2:select', function (e) {
        var data = e.params.data;
        vm.stockOnModalSync(data.id);
      });
      $('#STNumber').on('select2:select', function (e) {
        var data = e.params.data;
        vm.stockMax = vm.stocks[data.element.index].RemainQ;
        if( $("[name=Quan]").val() > vm.stockMax ){
          $("[name=Quan]").val(vm.stockMax);
        }
      });

      $('#invoiceBody').on('show.bs.modal', function (event) {
        var el = $(event.relatedTarget), modal = $(this), i = el.data('index');
        vm.activeIndex = i;
        vm.clearModal();
        if( i == -1 ){
          modal.find('.modal-title').text("افزودن ردیف جدید");
        }else{
          modal.find('.modal-title').text("ویرایش ردیف");

          $('#ItemDesc').append( new Option(vm.invoiceBody[i].ItemName, vm.invoiceBody[i].ItemNumber, false, false) ).trigger('change');
          vm.stockOnModalSync(vm.invoiceBody[i].ItemNumber);
          $("[name=Quan]").val(vm.invoiceBody[i].Quan);
          $("[name=Price]").val(vm.number_format(vm.invoiceBody[i].Price));
        }
      });

      $('[data-input-mask="money"]').mask('000,000,000,000,000', {reverse: true});

    });
  }
}
</script>

<style scoped>
.btn-xs {
  padding: 2px 5px;
  font-size: 11px;
  height: 21px;
}
.font-en{
  font-family: Sans-Serif, Tahoma, Arial;
}
.hide{display: none}
.btn-receipt-new{
  position: absolute;
  width: 150px;
  left: 0;
  margin-top: -38px;
  justify-content: center;
}
</style>
